// Hybrid shelf-life AI.
//
// Layer 1a — physics (kinetic) model: every temperature/humidity reading "uses up" shelf
//   life at a rate given by the Q10 law. It only knows the storage conditions.
// Layer 1b — freshness-tag signals: each pallet carries a tag measuring CO₂, ethylene and
//   ammonia/VOC. These gases come from the food itself, so they reveal spoilage that the
//   temperature history cannot explain (a bad harvest, poor pre-cooling, contamination,
//   bruising from shocks).
// Layer 1c — machine learning: per product category, a ridge regression learns real shelf
//   life from physics features + gas features + shock/handling/transit, trained on
//   historical batch outcomes. A physics-only model is trained alongside for comparison.
// Layer 1d — learned thresholds: for each category the AI chooses the Good/Mid/Low/Dispose
//   cut-offs on its own predictions that best match historical outcomes, penalising
//   "graded better than it really was" 4× more than the opposite. Noisier predictions
//   therefore get safer (higher) thresholds automatically.
// Statistical anomaly detection runs on every sensor stream and feeds the LLM agents.

import { PRODUCTS, CATEGORIES, OUTCOME_WINDOWS } from './catalog.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// ---------- physics ----------

// Relative rate of quality loss vs. ideal storage (1.0 = ideal).
export function spoilageRate(product, temp, rh) {
  let rate;
  if (temp >= product.idealTemp) rate = Math.pow(product.q10, (temp - product.idealTemp) / 10);
  else if (product.chillSensitive) rate = 1 + 0.12 * (product.idealTemp - temp); // chilling injury
  else rate = Math.max(0.7, Math.pow(product.q10, (temp - product.idealTemp) / 10));
  const [lo, hi] = product.rh;
  const rhDev = rh < lo ? lo - rh : rh > hi ? rh - hi : 0;
  return rate * (1 + rhDev * 0.012);
}

// ---------- the real world (hidden quality) and what the freshness tag measures ----------

const E3 = Math.exp(3) - 1;
const gasCurve = x => (Math.exp(3 * clamp(x, 0, 1.3)) - 1) / E3; // gas rises sharply near end of life
const gasCurveInv = s => Math.log(1 + clamp(s, 0, 2) * E3) / 3;
const warmFactor = (p, temp) => clamp(1 + 0.06 * (temp - p.idealTemp), 0.6, 2.5); // respiration speeds up when warm

export const GAS_NAMES = { co2: 'CO₂', eth: 'Ethylene', voc: 'Ammonia/VOC' };
export const GAS_UNITS = { co2: 'ppm', eth: 'ppm', voc: 'ppm' };

// gain: per-pallet factor for tag placement / airflow (a tag deep in a pallet reads higher
// than one near the evaporator fan) — one of the things that keeps the AI honest.
export function tagGas(p, trueFrac, temp, rand, gain = 1) {
  const s = gasCurve(trueFrac) * gain;
  const n = () => 1 + (rand() - 0.5) * 0.3;
  const w = warmFactor(p, temp);
  const g = p.gas;
  return {
    co2: Math.round((g.co2[0] + (g.co2[1] - g.co2[0]) * s * w) * n()),
    eth: +((g.eth[0] + (g.eth[1] - g.eth[0]) * s * w) * n()).toFixed(3),
    voc: +((g.voc[0] + (g.voc[1] - g.voc[0]) * s) * n()).toFixed(2),
  };
}

// How "old" the gas level says the food is (0 = fresh, 1 = end of life).
export function gasAge(p, gas, reading, temp) {
  const [base, peak] = p.gas[gas];
  const w = gas === 'voc' ? 1 : warmFactor(p, temp);
  return gasCurveInv((reading - base) / (peak - base) / w);
}
const secondaryGas = p => (p.gas.primary === 'co2' ? 'voc' : 'co2');

export function newExposure(extra = {}) {
  return { abuseH: 0, excessDegH: 0, humDevH: 0, handlingEvents: 1, transitH: 0, shocks: 0, maxTemp: -99, doorOpens: 0, ...extra };
}

// Advance a batch by dtH hours at the given conditions.
// lifeUsedH = what the physics model believes; trueUsedH = reality (hidden from the AI).
export function stepBatch(b, p, env, dtH, { inTransit = false, shock = false, door = false } = {}) {
  const rate = spoilageRate(p, env.temp, env.rh);
  b.lifeUsedH += rate * dtH;
  b.trueUsedH += rate * b.hidden.factor * dtH + (shock && p.shockSensitive ? 0.025 * p.baseShelfH : 0);
  const e = b.exposure;
  if (env.temp > p.maxSafeTemp) e.abuseH += dtH;
  e.excessDegH += Math.max(0, env.temp - (p.idealTemp + 2)) * dtH;
  const [lo, hi] = p.rh;
  e.humDevH += (env.rh < lo ? lo - env.rh : env.rh > hi ? env.rh - hi : 0) * dtH;
  if (inTransit) e.transitH += dtH;
  if (shock) e.shocks += 1;
  if (door) e.doorOpens += 1;
  e.maxTemp = Math.max(e.maxTemp, env.temp);
}

// ---------- features ----------

function physicsFeatures(b, p, ageH) {
  const e = b.exposure;
  return [1, b.lifeUsedH / p.baseShelfH, e.abuseH / 10, e.humDevH / Math.max(1, ageH) / 5, e.transitH / 48, e.handlingEvents / 5];
}
function hybridFeatures(b, p, ageH, tagNow, tagPrev) {
  const prim = p.gas.primary, sec = secondaryGas(p);
  const g1 = gasAge(p, prim, tagNow[prim], tagNow.temp);
  const g2 = gasAge(p, sec, tagNow[sec], tagNow.temp);
  const trend = tagPrev ? g1 - gasAge(p, prim, tagPrev[prim], tagPrev.temp) : 0;
  return [...physicsFeatures(b, p, ageH), g1, g2, trend, b.exposure.shocks / 5];
}

// ---------- training ----------

function ridge(X, y, lambda) {
  const n = X[0].length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => {
    if (j === n) return X.reduce((s, row, k) => s + row[i] * y[k], 0);
    return X.reduce((s, row) => s + row[i] * row[j], 0) + (i === j && i > 0 ? lambda : 0);
  }));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

export function hiddenFactor(rand) {
  // Most batches behave as the physics predicts; ~20% are secretly worse
  // (poor pre-cooling at the farm, contamination, a bad harvest).
  return rand() < 0.2 ? 1.5 + rand() * 0.9 : 0.85 + rand() * 0.3;
}
export const tagGain = rand => 0.7 + rand() * 0.6;

// One simulated historical batch: arrives by truck, then sits in a cold room.
// In production these rows come from QA inspection records (prediction vs. what was found).
function simulateHistory(p, rand) {
  const b = { lifeUsedH: 0, trueUsedH: 0, hidden: { factor: hiddenFactor(rand), gain: tagGain(rand) }, exposure: newExposure() };
  const pre = p.baseShelfH * rand() * 0.25;
  b.lifeUsedH = pre; b.trueUsedH = pre * b.hidden.factor;
  const dt = 2;
  const steps = Math.max(4, Math.floor((p.baseShelfH * (0.1 + rand() * 1.1)) / dt));
  const transitSteps = Math.floor(rand() * 24);
  const offset = (rand() - 0.3) * 3;
  let excursion = 0;
  const tags = [];
  for (let i = 0; i < steps; i++) {
    const inTransit = i < transitSteps;
    if (!excursion && rand() < 0.015) excursion = 1 + Math.floor(rand() * 5);
    const temp = p.idealTemp + offset + (excursion ? 3 + rand() * 9 : (rand() - 0.5)) + (inTransit ? rand() : 0);
    if (excursion) excursion--;
    const rh = (p.rh[0] + p.rh[1]) / 2 + (rand() - 0.5) * 16;
    const shock = rand() < (inTransit ? 0.06 : 0.01);
    stepBatch(b, p, { temp, rh }, dt, { inTransit, shock });
    if (i >= steps - 4) tags.push({ temp, ...tagGas(p, b.trueUsedH / p.baseShelfH, temp, rand, b.hidden.gain) });
  }
  const ageH = pre + steps * dt;
  return {
    phys: physicsFeatures(b, p, ageH),
    hyb: hybridFeatures(b, p, ageH, tags.at(-1), tags[0]),
    y: Math.min(1.3, b.trueUsedH / p.baseShelfH),
    base: p.baseShelfH,
  };
}

function gradeFromHours(h, t) {
  return h >= t.good ? 'good' : h >= t.mid ? 'mid' : h >= t.low ? 'low' : 'dispose';
}

// Pick each cut-off on predicted hours to best reproduce historical outcomes.
function learnThresholds(rows, predKey, windows) {
  const out = {};
  for (const k of ['good', 'mid', 'low']) {
    let best = { cost: Infinity, t: windows[k] };
    for (let t = 0; t <= 480; t += 2) {
      let cost = 0;
      for (const r of rows) {
        const truthOk = r.trueH >= windows[k];
        const predOk = r[predKey] >= t;
        if (predOk && !truthOk) cost += 4; // unsafe: graded better than reality
        else if (!predOk && truthOk) cost += 1; // wasteful: graded worse than reality
      }
      if (cost < best.cost) best = { cost, t };
    }
    out[k] = best.t;
  }
  out.mid = Math.min(out.mid, out.good);
  out.low = Math.min(out.low, out.mid);
  return out;
}

function evaluate(rows, predKey, thKey, windows) {
  let ok = 0, unsafe = 0, ssRes = 0, ssTot = 0, abs = 0;
  const mean = rows.reduce((s, r) => s + r.trueH, 0) / rows.length;
  for (const r of rows) {
    const g = gradeFromHours(r[predKey], r[thKey]);
    const truth = gradeFromHours(r.trueH, windows);
    if (g === truth) ok++;
    const order = ['good', 'mid', 'low', 'dispose'];
    if (order.indexOf(g) < order.indexOf(truth)) unsafe++;
    ssRes += (r.trueH - r[predKey]) ** 2; ssTot += (r.trueH - mean) ** 2; abs += Math.abs(r.trueH - r[predKey]);
  }
  return { r2: 1 - ssRes / ssTot, maeH: abs / rows.length, gradeAccuracy: ok / rows.length, overGradedPct: unsafe / rows.length };
}

export function trainModels(rand = Math.random, perProduct = 110) {
  const byCat = {};
  for (const c of CATEGORIES) {
    const rows = [];
    for (const p of PRODUCTS.filter(x => x.category === c.id)) for (let i = 0; i < perProduct; i++) rows.push(simulateHistory(p, rand));
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    const split = Math.floor(rows.length * 0.8);
    const train = rows.slice(0, split), test = rows.slice(split);
    const wPhys = ridge(train.map(r => r.phys), train.map(r => r.y), 0.3);
    const wHyb = ridge(train.map(r => r.hyb), train.map(r => r.y), 0.3);
    const withPred = arr => arr.map(r => ({
      trueH: Math.max(0, (1 - r.y) * r.base),
      physH: Math.max(0, (1 - clamp(dot(r.phys, wPhys), 0, 1.3)) * r.base),
      hybH: Math.max(0, (1 - clamp(dot(r.hyb, wHyb), 0, 1.3)) * r.base),
      base: r.base,
      resid: (1 - r.y) - (1 - clamp(dot(r.hyb, wHyb), 0, 1.3)),
    }));
    const tr = withPred(train), te = withPred(test);
    const w = OUTCOME_WINDOWS[c.id];
    const thPhys = learnThresholds(tr, 'physH', w);
    const thHyb = learnThresholds(tr, 'hybH', w);
    te.forEach(r => { r.thPhys = thPhys; r.thHyb = thHyb; });
    const rmseFrac = Math.sqrt(te.reduce((s, r) => s + r.resid ** 2, 0) / te.length);
    byCat[c.id] = {
      wPhys, wHyb, rmseFrac,
      thresholds: thHyb, physicsThresholds: thPhys, outcomeWindows: w,
      physics: evaluate(te, 'physH', 'thPhys', w),
      hybrid: evaluate(te, 'hybH', 'thHyb', w),
      trainSize: train.length, testSize: test.length,
    };
  }
  return { byCat, featureNames: ['bias', 'physics life used', 'abuse h', 'humidity dev', 'transit', 'handling', 'primary gas age', 'secondary gas age', 'gas trend', 'shocks'] };
}

// ---------- live prediction ----------

export function predict(b, p, env, model, ageH) {
  const cat = model.byCat[p.category];
  const tags = b.tagHistory;
  const now = tags.at(-1) ?? { temp: env.temp, ...tagGas(p, b.trueUsedH / p.baseShelfH, env.temp, Math.random) };
  const prev = tags.length > 6 ? tags.at(-7) : tags[0];
  const fp = physicsFeatures(b, p, ageH);
  const fh = hybridFeatures(b, p, ageH, now, prev);
  const usedPhys = clamp(dot(fp, cat.wPhys), 0, 1.3);
  const usedHyb = clamp(dot(fh, cat.wHyb), 0, 1.3);
  const physicsIdealH = Math.max(0, (1 - usedPhys) * p.baseShelfH);
  const remainingIdealH = Math.max(0, (1 - usedHyb) * p.baseShelfH);
  const currentRate = spoilageRate(p, env.temp, env.rh);
  const e = b.exposure;
  const safetyBreach = !!p.highRisk && e.abuseH >= 4;
  const fraction = remainingIdealH / p.baseShelfH;
  let risk = 100 * Math.pow(1 - clamp(fraction, 0, 1), 1.4) + e.abuseH * 6 + (currentRate > 2 ? 10 : 0);
  risk = Math.round(clamp(safetyBreach ? 100 : risk, 0, 100));
  return {
    ageH: Math.round(ageH),
    physicsH: Math.round(physicsIdealH),
    physicsGrade: gradeFromHours(physicsIdealH, cat.physicsThresholds),
    remainingIdealH: Math.round(remainingIdealH),
    remainingH: Math.round((remainingIdealH / currentRate) * 10) / 10, // if conditions stay as they are now
    uncertaintyH: Math.round(cat.rmseFrac * p.baseShelfH),
    fraction: +fraction.toFixed(3),
    currentRate: +currentRate.toFixed(2),
    gasAge: +fh[6].toFixed(2),
    gasTrend: +fh[8].toFixed(3),
    mlGrade: gradeFromHours(remainingIdealH, cat.thresholds),
    thresholds: cat.thresholds,
    risk,
    safetyBreach,
  };
}

// ---------- anomaly detection (rolling z-score + level checks) ----------

const MIN_DELTA = { temp: 1.5, rh: 6, co2: 300, eth: 0.3, voc: 2 };
const LABEL = { temp: 'Temperature', rh: 'Humidity', ...GAS_NAMES };

export function detectAnomalies(tags, p) {
  const out = [];
  if (tags.length < 8) return out;
  const last = tags.at(-1);
  const win = tags.slice(-25, -1);
  for (const k of ['temp', 'rh', 'co2', 'eth', 'voc']) {
    const mean = win.reduce((s, r) => s + r[k], 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, r) => s + (r[k] - mean) ** 2, 0) / win.length) || 1e-6;
    const z = (last[k] - mean) / sd;
    if (Math.abs(z) > 3 && Math.abs(last[k] - mean) > MIN_DELTA[k]) {
      out.push({ sensor: k, text: `${LABEL[k]} ${z > 0 ? 'spike' : 'drop'}: ${last[k]} vs usual ${+mean.toFixed(2)} (z=${z.toFixed(1)})` });
    }
  }
  const prim = p.gas.primary;
  const age = gasAge(p, prim, last[prim], last.temp);
  if (age > 0.75) out.push({ sensor: prim, text: `${LABEL[prim]} at ${last[prim]} ${GAS_UNITS[prim]}: near spoilage level (gas age ${Math.round(age * 100)}%)` });
  const shocks = tags.slice(-6).filter(r => r.shock).length;
  if (shocks) out.push({ sensor: 'shock', text: `${shocks} shock event${shocks > 1 ? 's' : ''} in the last hour` });
  return out;
}
