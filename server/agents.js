// Layer 2 — a team of three Claude agents that turns the ML output and raw sensor
// evidence into a decision for every batch:
//
//   🔬 Sensor analyst   reads all sensor streams + detected anomalies and explains what is
//                       physically happening to the food.
//   🛡️ Food-safety      checks food-safety limits and can veto (unsafe → dispose).
//   🚚 Decision agent   combines the ML prediction, the AI-learned thresholds and both
//                       agents' findings into the final grade, reason and action.
//
// The analyst and safety agents run in parallel; the decision agent runs after them.
// Deterministic rule-based versions of all three run on every sensor reading and are used
// whenever Claude is not configured, so the app always works offline.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
export const llmModel = MODEL;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  client ??= new Anthropic();
  return client;
}
export const llmAvailable = () => Boolean(getClient());

const resultsSchema = (props, required) => ({
  type: 'object',
  properties: { results: { type: 'array', items: { type: 'object', properties: { batchId: { type: 'string' }, ...props }, required: ['batchId', ...required], additionalProperties: false } } },
  required: ['results'],
  additionalProperties: false,
});

const AGENTS = {
  analyst: {
    system: `You are the Sensor Analyst agent of a cold-chain warehouse in Qatar.
Each batch has a pallet freshness tag (temperature, humidity, CO2, ethylene, ammonia/VOC, shock) plus the storage location's sensors.
For each batch, interpret the readings and the detected anomalies: what is physically happening to the food?
Key knowledge: ammonia/VOC rising = protein spoilage in meat, fish and dairy; ethylene rising = ripening of climacteric fruit (tomato, mango, banana);
CO2 rising = respiration or microbial growth in produce; shocks bruise soft produce; humidity too low wilts leafy greens.
"gasAge" is how old the food smells relative to its shelf life (0 = fresh, 1 = end of life) — compare it with the physics estimate: a gap means the batch is ageing faster than its temperature history explains.
Return concern none|low|medium|high and findings (max 25 words, cite the key numbers).`,
    schema: resultsSchema({ concern: { type: 'string', enum: ['none', 'low', 'medium', 'high'] }, findings: { type: 'string' } }, ['concern', 'findings']),
  },
  safety: {
    system: `You are the Food-Safety agent of a cold-chain warehouse in Qatar.
For each batch decide: "safe", "caution" or "unsafe".
Hard limits: high-risk foods (meat, fish, dairy) held above their max safe temperature for 4 hours or more are unsafe;
a failed QA inspection (sensory score 1-2) is unsafe; spoilage-level ammonia/VOC (vocAge >= 0.9) in meat, fish or dairy is unsafe.
Use "caution" for partial exposure (abuse >= 1.5 h, vocAge >= 0.7, probe temperature at receipt above the safe limit).
Also say whether the batch may be donated to a food-rescue charity (only if not unsafe and at least 12 h of shelf life remain).
rule: max 18 words citing the limit you applied.`,
    schema: resultsSchema({ verdict: { type: 'string', enum: ['safe', 'caution', 'unsafe'] }, rule: { type: 'string' }, donationAllowed: { type: 'boolean' } }, ['verdict', 'rule', 'donationAllowed']),
  },
  decision: {
    system: `You are the Decision agent of a cold-chain warehouse in Qatar. You make the final call for each batch.
Grades and where they go:
- good: regular business buyers (restaurants, hotels, supermarkets) on the scheduled reefer route, full price.
- mid: small shops and middlemen who resell within days, 20% off.
- low: flash sale with same-day delivery to kitchens that cook it today, 50% off.
- dispose: removed from sale.
The ML model predicts remaining shelf life (remainingIdealH, with uncertaintyH) and grades it with thresholds it learned from historical outcomes for this product category (mlGrade, thresholds).
Start from mlGrade. You may move one grade up or down when the analyst's findings or the safety verdict justify it — say why. Only choose dispose if mlGrade is dispose or the safety verdict is unsafe (then it must be dispose).
reason: max 22 words, cite numbers. action: one practical action, max 14 words (e.g. sell first, move to Chiller B, reroute, inspect, donate).`,
    schema: resultsSchema({ grade: { type: 'string', enum: ['good', 'mid', 'low', 'dispose'] }, reason: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] } }, ['grade', 'reason', 'action', 'confidence']),
  },
};

async function callAgent(c, name, items) {
  const agent = AGENTS[name];
  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: agent.system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: agent.schema } },
    messages: [{ role: 'user', content: `Batches (${items.length}):\n${JSON.stringify(items)}` }],
  };
  let res;
  try {
    // Server-side fallback: if the primary model declines, the API retries on a fallback model.
    res = await c.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    res = await c.messages.create(body);
  }
  if (res.stop_reason === 'refusal') throw new Error(`${name} agent: model declined`);
  const text = res.content.find(b => b.type === 'text')?.text;
  return { model: res.model, map: new Map(JSON.parse(text).results.map(r => [r.batchId, r])) };
}

// cases: [{ batchId, analystInput, safetyInput, ml }] — see index.js buildAgentCase()
export async function runClaudeAgents(cases) {
  const c = getClient();
  if (!c) return { source: 'rules', error: 'ANTHROPIC_API_KEY not set' };
  try {
    const [analyst, safety] = await Promise.all([
      callAgent(c, 'analyst', cases.map(x => x.analystInput)),
      callAgent(c, 'safety', cases.map(x => x.safetyInput)),
    ]);
    const decision = await callAgent(c, 'decision', cases.map(x => ({
      batchId: x.batchId, product: x.analystInput.product, ml: x.ml,
      analyst: analyst.map.get(x.batchId) ?? null, safety: safety.map.get(x.batchId) ?? null,
    })));
    return { source: 'claude', model: decision.model, analyst: analyst.map, safety: safety.map, decision: decision.map };
  } catch (err) {
    return { source: 'rules', error: err.message?.slice(0, 200) || String(err) };
  }
}

// ---------- deterministic versions (offline fallback + between Claude runs) ----------

const GRADES = ['good', 'mid', 'low', 'dispose'];
const worse = (g, n = 1) => GRADES[Math.min(3, GRADES.indexOf(g) + n)];

export function ruleAnalyst(x) {
  const a = x.analystInput;
  const gap = a.gasAge - a.physicsLifeUsed;
  let concern = 'none';
  if (a.anomalies.length) concern = 'low';
  if (gap > 0.15 || a.anomalies.length >= 2) concern = 'medium';
  if (gap > 0.3 || a.gasAge > 0.8) concern = 'high';
  const parts = [];
  if (gap > 0.15) parts.push(`${a.primaryGas} says ${Math.round(a.gasAge * 100)}% of life used vs ${Math.round(a.physicsLifeUsed * 100)}% by temperature — ageing faster than expected`);
  parts.push(...a.anomalies.slice(0, 2));
  return { concern, findings: parts.join('; ') || 'All sensor readings normal and consistent with storage history.' };
}

export function ruleSafety(x) {
  const s = x.safetyInput;
  let verdict = 'safe', rule = 'All food-safety limits respected.';
  if (s.highRisk && s.abuseH >= 4) { verdict = 'unsafe'; rule = `${s.abuseH} h above ${s.maxSafeTempC} °C (limit 4 h for high-risk food).`; }
  else if (s.inspection && s.inspection.sensory <= 2) { verdict = 'unsafe'; rule = `Failed QA inspection (sensory score ${s.inspection.sensory}/5).`; }
  else if (s.highRisk && s.vocAge >= 0.9) { verdict = 'unsafe'; rule = `Spoilage-level ammonia/VOC (${s.voc} ppm) in high-risk food.`; }
  else if (s.abuseH >= 1.5 || (s.highRisk && s.vocAge >= 0.7) || (s.probeTempAtReceipt != null && s.probeTempAtReceipt > s.maxSafeTempC)) {
    verdict = 'caution'; rule = s.abuseH >= 1.5 ? `${s.abuseH} h above safe temperature so far.` : s.probeTempAtReceipt > s.maxSafeTempC ? `Arrived at ${s.probeTempAtReceipt} °C, above ${s.maxSafeTempC} °C.` : `Ammonia/VOC rising (${s.voc} ppm).`;
  }
  return { verdict, rule, donationAllowed: verdict !== 'unsafe' && s.remainingH >= 12 };
}

export function ruleDecision(x, analyst, safety) {
  const ml = x.ml;
  let grade = ml.mlGrade;
  let why = `ML predicts ${ml.remainingIdealH} h ± ${ml.uncertaintyH} h left; learned ${grade} band for ${x.analystInput.category}.`;
  // The analyst can downgrade by one step, but only the ML or the safety agent can dispose.
  if (analyst.concern === 'high' && grade !== 'dispose' && grade !== 'low') { grade = worse(grade); why = `Downgraded: ${analyst.findings.split(';')[0]}.`; }
  if (safety.verdict === 'caution' && grade === 'good') { grade = 'mid'; why = `Safety caution: ${safety.rule}`; }
  if (safety.verdict === 'unsafe') { grade = 'dispose'; why = `Safety veto: ${safety.rule}`; }
  const action = {
    good: 'Fulfil scheduled buyer orders, first-expired-first-out.',
    mid: 'Offer as wholesale lot to shops and middlemen.',
    low: 'Flash-sell today with same-day delivery; donate if unsold.',
    dispose: 'Quarantine, dispose and log the root cause.',
  }[grade];
  return { grade, reason: why, action, confidence: analyst.concern === 'none' ? 'high' : 'medium' };
}
