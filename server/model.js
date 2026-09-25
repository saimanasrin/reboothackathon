// Hybrid shelf-life engine.
//
// Stage 1 — kinetic (physics) model: every sensor reading "consumes" shelf life at a
//   rate given by the Q10 temperature law, plus humidity and chill-injury penalties.
// Stage 2 — machine-learning correction: a ridge regression trained on historical
//   batch outcomes learns how much real shelf life deviates from the kinetic estimate
//   given the batch's handling history (temperature abuse, humidity stress, handling
//   events, time in transit). The two are combined into one corrected prediction.
// Stage 3 — risk scoring and rule-based grade (the safety guardrail the LLM sits on).

import { GRADE_ORDER } from './catalog.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- Stage 1: kinetic model ----------

// Relative rate of quality loss vs. ideal storage (1.0 = ideal).
export function spoilageRate(product, temp, rh) {
  let rate;
  if (temp >= product.idealTemp) {
    rate = Math.pow(product.q10, (temp - product.idealTemp) / 10);
  } else if (product.chillSensitive) {
    rate = 1 + 0.12 * (product.idealTemp - temp); // chilling injury
  } else {
    rate = Math.max(0.7, Math.pow(product.q10, (temp - product.idealTemp) / 10));
  }
  const [lo, hi] = product.rh;
  const rhDev = rh < lo ? lo - rh : rh > hi ? rh - hi : 0;
  return rate * (1 + rhDev * 0.012);
}

// Advance one batch by dtH hours of exposure at the given reading.
export function accumulateExposure(batch, product, reading, dtH, inTransit) {
  const rate = spoilageRate(product, reading.temp, reading.rh);
  batch.lifeUsedH += rate * dtH;
  const e = batch.exposure;
  if (reading.temp > product.maxSafeTemp) e.abuseH += dtH;
  e.excessDegH += Math.max(0, reading.temp - (product.idealTemp + 2)) * dtH;
  const [lo, hi] = product.rh;
  e.humDevH += (reading.rh < lo ? lo - reading.rh : reading.rh > hi ? reading.rh - hi : 0) * dtH;
  if (inTransit) e.transitH += dtH;
  e.maxTemp = Math.max(e.maxTemp, reading.temp);
}

// ---------- Stage 2: learned correction ----------

function features(e, ageH) {
  return [
    1,
    e.excessDegH / 10,
    e.abuseH,
    e.humDevH / Math.max(1, ageH) / 5, // average humidity deviation
    e.handlingEvents,
    e.transitH / 24,
  ];
}
export const FEATURE_NAMES = ['bias', 'excess °C·h /10', 'abuse hours', 'avg humidity dev /5', 'handling events', 'transit days'];

// Solve (XᵀX + λI) w = Xᵀy with Gaussian elimination.
function ridge(X, y, lambda) {
  const n = X[0].length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => {
    if (j === n) return X.reduce((s, row, k) => s + row[i] * y[k], 0);
    return X.reduce((s, row) => s + row[i] * row[j], 0) + (i === j && i > 0 ? lambda : 0);
  }));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

function gaussian(rand) {
  const u = Math.max(1e-9, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Historical outcomes: in production these come from QA inspection records
// (predicted vs. observed end of shelf life). For the demo we synthesise 1,200
// past batches from a hidden ground-truth relationship plus noise.
export function trainCorrectionModel(rand = Math.random) {
  const X = [], y = [];
  for (let i = 0; i < 1200; i++) {
    const ageH = 24 + rand() * 300;
    const e = {
      excessDegH: rand() < 0.4 ? rand() * 120 : rand() * 15,
      abuseH: rand() < 0.25 ? rand() * 8 : 0,
      humDevH: rand() * 6 * ageH,
      handlingEvents: Math.floor(rand() * 5),
      transitH: rand() * 96,
    };
    const f = features(e, ageH);
    const truth = 1.03 - 0.03 * f[1] - 0.045 * f[2] - 0.035 * f[3] - 0.02 * f[4] - 0.025 * f[5];
    X.push(f);
    y.push(truth + gaussian(rand) * 0.03);
  }
  const split = 1000;
  const w = ridge(X.slice(0, split), y.slice(0, split), 0.5);
  const pred = X.slice(split).map(f => f.reduce((s, v, i) => s + v * w[i], 0));
  const test = y.slice(split);
  const mean = test.reduce((a, b) => a + b, 0) / test.length;
  const ssRes = test.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  const ssTot = test.reduce((s, v) => s + (v - mean) ** 2, 0);
  return {
    weights: w,
    featureNames: FEATURE_NAMES,
    trainSize: split,
    testSize: X.length - split,
    r2: 1 - ssRes / ssTot,
    rmse: Math.sqrt(ssRes / test.length),
  };
}

// ---------- Stage 3: combined prediction, risk and rule grade ----------

export function predict(batch, product, reading, model, simNow) {
  const ageH = (simNow - batch.receivedAt) / 3.6e6 + batch.ageAtReceiptH;
  const f = features(batch.exposure, ageH);
  const ratio = clamp(f.reduce((s, v, i) => s + v * model.weights[i], 0), 0.35, 1.1);

  const kineticRemainingH = Math.max(0, product.baseShelfH - batch.lifeUsedH);
  const effectiveLifeH = product.baseShelfH * ratio;
  const remainingIdealH = Math.max(0, effectiveLifeH - batch.lifeUsedH);
  const currentRate = spoilageRate(product, reading.temp, reading.rh);
  const remainingH = remainingIdealH / currentRate; // if conditions stay as they are now
  const fraction = remainingIdealH / product.baseShelfH;
  const band = model.rmse * product.baseShelfH / currentRate; // ± uncertainty in hours

  const e = batch.exposure;
  const safetyBreach = product.highRisk && e.abuseH >= 4;
  let risk = 100 * Math.pow(1 - clamp(fraction, 0, 1), 1.4) + e.abuseH * 6 + (currentRate > 2 ? 10 : 0);
  if (safetyBreach) risk = 100;
  risk = Math.round(clamp(risk, 0, 100));

  let ruleGrade;
  if (safetyBreach || remainingH <= 6) ruleGrade = 'dispose';
  else if (remainingH <= 48 || (fraction < 0.12 && remainingH <= 96)) ruleGrade = 'low';
  else if (fraction < 0.45 || risk >= 50 || remainingH <= 120) ruleGrade = 'mid';
  else ruleGrade = 'good';

  return {
    ageH: Math.round(ageH),
    kineticRemainingH: Math.round(kineticRemainingH),
    mlRatio: +ratio.toFixed(3),
    remainingH: Math.round(remainingH * 10) / 10,
    remainingIdealH: Math.round(remainingIdealH),
    uncertaintyH: Math.round(band),
    fraction: +fraction.toFixed(3),
    currentRate: +currentRate.toFixed(2),
    risk,
    safetyBreach,
    ruleGrade,
  };
}

export const worseGrade = (a, b) => (GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b);
