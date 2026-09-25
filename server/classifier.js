// LLM grading step: the recalculated shelf life of every batch is sent to Claude,
// which classifies each batch as good / mid / low / dispose and writes a short reason
// and recommended action. Without an API key (or if the call fails) the rule-based
// grade from the hybrid model is used, so the demo always works offline.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

const SYSTEM = `You are the food-safety and distribution AI of a cold-chain warehouse in Qatar.
For each batch you receive the output of a hybrid shelf-life model (kinetic Q10 model + ML correction).
Classify every batch into exactly one grade:
- "good": plenty of shelf life left, no safety concerns -> regular business buyers (restaurants, hotels, supermarkets) on the scheduled delivery route.
- "mid": noticeably reduced shelf life (roughly 20-50% left or elevated risk) but still sellable for several days -> small shops and middlemen.
- "low": safe but must be used within ~48 hours -> discounted flash sale with same-day delivery to kitchens that cook it today.
- "dispose": expired, under ~6 hours left, or a food-safety breach (high-risk food held above its safe temperature for 4h or more) -> dispose immediately.
Food safety comes first: never grade a batch better than the evidence supports. The "ruleGrade" field is a deterministic baseline; you may deviate by one grade when the data justifies it and must say why.
For each batch write a reason (max 20 words, cite the key numbers) and one practical action (max 14 words), e.g. inspect, move to another chiller, reroute, sell first, donate if safe.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          batchId: { type: 'string' },
          grade: { type: 'string', enum: ['good', 'mid', 'low', 'dispose'] },
          reason: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['batchId', 'grade', 'reason', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  client ??= new Anthropic();
  return client;
}

export function llmAvailable() {
  return Boolean(getClient());
}
export const llmModel = MODEL;

// Rule-based fallback text, used when Claude is not configured.
export function ruleExplanation(item) {
  const h = item.remainingH;
  switch (item.ruleGrade) {
    case 'dispose':
      return item.safetyBreach
        ? { reason: `Held above safe temperature for ${item.abuseH} h — food-safety breach.`, action: 'Quarantine and dispose; log the incident.' }
        : { reason: `Only ${h} h of shelf life left at current conditions.`, action: 'Remove from sale and dispose / compost.' };
    case 'low':
      return { reason: `${h} h left (${Math.round(item.fraction * 100)}% of life). Must be eaten within 2 days.`, action: 'Flash-sell at 50% off; notify matching customers.' };
    case 'mid':
      return { reason: `${Math.round(item.fraction * 100)}% of shelf life left, risk ${item.risk}/100.`, action: 'Offer to partner shops and middlemen first.' };
    default:
      return { reason: `${Math.round(item.fraction * 100)}% of shelf life left, conditions stable.`, action: 'Fulfil standing customer orders (FEFO).' };
  }
}

async function callClaude(c, items) {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Grade these ${items.length} batches:\n${JSON.stringify(items)}` }],
  };
  try {
    // Server-side fallback: if the primary model declines, the API retries on a fallback model.
    return await c.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) return await c.messages.create(body);
    throw err;
  }
}

// items: [{ batchId, product, category, remainingH, fraction, risk, abuseH, maxTemp, currentTemp, location, ruleGrade, safetyBreach }]
export async function classifyWithLLM(items) {
  const c = getClient();
  if (!c) return { source: 'rules', results: null, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const res = await callClaude(c, items);
    if (res.stop_reason === 'refusal') return { source: 'rules', results: null, error: 'Model declined the request' };
    const text = res.content.find(b => b.type === 'text')?.text;
    const parsed = JSON.parse(text);
    return { source: 'claude', model: res.model, results: parsed.results };
  } catch (err) {
    return { source: 'rules', results: null, error: err.message?.slice(0, 200) || String(err) };
  }
}
