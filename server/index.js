// FreshRoute server: REST API + sensor pipeline + simulation loop + static frontend.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, PRODUCTS, LOCATIONS, ROUTES, GRADE_ORDER, productById, locationById, homeRoomFor } from './catalog.js';
import { accumulateExposure, trainCorrectionModel, predict } from './model.js';
import { classifyWithLLM, ruleExplanation, llmAvailable, llmModel } from './classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');

const PORT = Number(process.env.PORT || 3000);
const TICK_MS = Number(process.env.TICK_MS || 5000); // real time between sensor readings
const SIM_MIN_PER_TICK = Number(process.env.SIM_MINUTES_PER_TICK || 10); // simulated minutes per reading
const AI_EVERY_TICKS = Number(process.env.AI_EVERY_TICKS || 36);
const INGEST_KEY = process.env.INGEST_KEY || 'demo-ingest-key';
const MANAGER_CODE = process.env.MANAGER_CODE || 'COLDCHAIN';
const HISTORY_LEN = 144;

// ---------- utilities ----------

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Date.now() & 0xffff);
const noise = () => (rand() - 0.5) * 2;
const round1 = v => Math.round(v * 10) / 10;
const id = prefix => `${prefix}-${crypto.randomBytes(3).toString('hex')}`;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function publicUser(u) {
  const { hash, salt, notifiedKeys, ...rest } = u;
  return rest;
}

// ---------- state ----------

const model = trainCorrectionModel(mulberry32(42));
let db;
let batchCounter = 1000;

function makeBatch(productId, locationId, simNow, { usedFrac, origin, qty, exposure } = {}) {
  const p = productById[productId];
  const frac = usedFrac ?? 0.05 + rand() * 0.25;
  return {
    id: `B-${++batchCounter}`,
    productId,
    locationId,
    origin: origin ?? 'Hamad Port',
    qty: qty ?? Math.round(20 + rand() * 180),
    initialQty: 0,
    receivedAt: simNow,
    ageAtReceiptH: Math.round(p.baseShelfH * frac),
    lifeUsedH: p.baseShelfH * frac,
    exposure: { abuseH: 0, excessDegH: 0, humDevH: 0, handlingEvents: 1, transitH: 12, maxTemp: p.idealTemp, ...exposure },
    status: 'active',
    grade: 'good',
    gradeSource: 'rules',
    reason: '',
    action: '',
    llm: null,
    override: null,
    pred: null,
  };
}

const ORIGINS = {
  meat: ['Australia via Hamad Port', 'Brazil via Hamad Port', 'Local farm — Al Khor', 'Saudi Arabia via Abu Samra'],
  dairy: ['Local dairy — Al Khor', 'Saudi Arabia via Abu Samra', 'Turkey via Hamad Port'],
  vegetables: ['Local greenhouse — Al Shahaniya', 'Jordan via Abu Samra', 'Netherlands via Hamad Port'],
  fruits: ['Egypt via Hamad Port', 'India via Hamad Port', 'Spain via Hamad Port', 'Philippines via Hamad Port'],
};
const pick = arr => arr[Math.floor(rand() * arr.length)];

function seedTruckLoad(truckId, simNow) {
  const loads = {
    'S-05': ['strawberry', 'chicken', 'milk', 'spinach'],
    'S-06': ['tomato', 'lamb', 'yogurt', 'cucumber'],
  };
  const truck = locationById[truckId];
  return loads[truckId].map(pid => makeBatch(pid, truckId, simNow, {
    usedFrac: 0.08 + rand() * 0.15,
    origin: truck.site.split(' → ')[0],
    exposure: { transitH: 6 + rand() * 30 },
  }));
}

function freshDb() {
  const simNow = Date.now();
  batchCounter = 1000;
  const sensors = {};
  for (const l of LOCATIONS) {
    sensors[l.id] = {
      id: l.id, temp: l.setpoint + noise() * 0.3, rh: l.rhSet, door: false, online: true,
      setpoint: l.setpoint, rhSet: l.rhSet, fault: null, faultTicks: 0,
      etaH: l.etaH ?? null, status: l.kind === 'truck' ? 'in-transit' : 'ok',
      history: [], externalTick: -99,
    };
  }
  const batches = [];
  // Stock in the warehouse rooms, spread across the whole freshness range.
  const usedFracs = [0.1, 0.2, 0.35, 0.5, 0.62, 0.78];
  for (const p of PRODUCTS) {
    const room = homeRoomFor(p);
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      batches.push(makeBatch(p.id, room.id, simNow, {
        usedFrac: pick(usedFracs) + noise() * 0.04,
        origin: pick(ORIGINS[p.category]),
      }));
    }
  }
  // Two scripted problem batches for the demo.
  batches.push(makeBatch('beef-mince', 'S-01', simNow, { usedFrac: 0.35, origin: 'Brazil via Hamad Port', qty: 60, exposure: { abuseH: 4.5, maxTemp: 9.8, excessDegH: 40, handlingEvents: 3 } }));
  batches.push(makeBatch('strawberry', 'S-03', simNow, { usedFrac: 0.62, origin: 'Egypt via Hamad Port', qty: 45, exposure: { excessDegH: 70, handlingEvents: 3, transitH: 60 } }));
  batches.push(...seedTruckLoad('S-05', simNow), ...seedTruckLoad('S-06', simNow));
  for (const b of batches) b.initialQty = b.qty;

  const users = [];
  const addUser = (u, pw) => { const { salt, hash } = hashPassword(pw); users.push({ id: id('U'), createdAt: simNow, notifiedKeys: [], salt, hash, ...u }); };
  addUser({ email: 'manager@example.com', name: 'Warehouse Manager', role: 'manager', phone: '+974 5000 0000', businessName: 'Doha Central Cold Store', area: 'Industrial Area', accountType: 'manager', prefs: [] }, 'manager123');
  addUser({ email: 'chef@example.com', name: 'Chef Omar', role: 'customer', accountType: 'restaurant', businessName: 'Corniche Grill', area: 'West Bay', phone: '+974 5555 1234', prefs: [{ productId: 'chicken', frequency: 'daily', qty: 40 }, { productId: 'tomato', frequency: 'daily', qty: 15 }, { productId: 'lettuce', frequency: 'weekly', qty: 20 }] }, 'demo123');
  addUser({ email: 'sara@example.com', name: 'Sara', role: 'customer', accountType: 'household', businessName: '', area: 'Al Sadd', phone: '+974 5555 9876', prefs: [{ productId: 'strawberry', frequency: 'weekly', qty: 2 }, { productId: 'milk', frequency: 'daily', qty: 2 }] }, 'demo123');
  addUser({ email: 'shop@example.com', name: 'Ahmed', role: 'customer', accountType: 'shop', businessName: 'Al Rayyan Mini Mart', area: 'Al Rayyan', phone: '+974 5555 4455', prefs: [{ productId: 'banana', frequency: 'daily', qty: 30 }, { productId: 'laban', frequency: 'daily', qty: 50 }, { productId: 'yogurt', frequency: 'weekly', qty: 20 }] }, 'demo123');

  return {
    version: 1, simNow, tick: 0, sensors, batches, users, sessions: {}, alerts: [], orders: [],
    notifications: [], events: [], aiRuns: [],
    stats: { disposedKg: 0, flashSoldKg: 0, midSoldKg: 0, freshSoldKg: 0, donatedKg: 0 },
  };
}

function loadDb() {
  if (!process.argv.includes('--reset') && fs.existsSync(DB_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      batchCounter = Math.max(1000, ...loaded.batches.map(b => Number(b.id.split('-')[1]) || 0));
      console.log(`Loaded state from ${path.relative(ROOT, DB_FILE)}`);
      return loaded;
    } catch (e) {
      console.warn('Could not read saved state, starting fresh:', e.message);
    }
  }
  return freshDb();
}
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

db = loadDb();

// ---------- event log, alerts & notifications ----------

function logEvent(type, message, extra = {}) {
  db.events.unshift({ id: id('E'), at: db.simNow, type, message, ...extra });
  db.events.length = Math.min(db.events.length, 200);
}

function raiseAlert(key, fields) {
  const existing = db.alerts.find(a => a.key === key && a.status !== 'resolved');
  if (existing) {
    Object.assign(existing, { message: fields.message, severity: fields.severity });
    return existing;
  }
  const alert = { id: id('A'), key, status: 'open', createdAt: db.simNow, ...fields };
  db.alerts.unshift(alert);
  logEvent('alert', `${fields.title}: ${fields.message}`, { severity: fields.severity });
  return alert;
}
function resolveAlert(key, note) {
  for (const a of db.alerts) {
    if (a.key === key && a.status !== 'resolved') {
      a.status = 'resolved'; a.resolvedAt = db.simNow; if (note) a.note = note;
    }
  }
}

function notify(user, key, n) {
  if (user.notifiedKeys.includes(key)) return;
  user.notifiedKeys.push(key);
  if (user.notifiedKeys.length > 500) user.notifiedKeys.splice(0, 100);
  db.notifications.unshift({ id: id('N'), userId: user.id, at: db.simNow, read: false, ...n });
}

// ---------- the pipeline: sensors -> exposure -> hybrid model -> grade -> routing ----------

function simulateSensor(s, loc) {
  if (db.tick - s.externalTick < 3) return; // a real sensor is pushing data; don't simulate
  if (loc.kind === 'truck' && s.status !== 'in-transit') { s.temp += (s.setpoint - s.temp) * 0.3; return; }

  let target = s.setpoint;
  let rhTarget = s.rhSet;
  // Qatar ambient is 40 °C+, so a dead reefer warms steadily.
  if (s.fault === 'compressor') { target = 8 + Math.min(14, s.faultTicks * 0.3); rhTarget = s.rhSet - 18; }
  if (s.fault === 'door') { target = s.setpoint + 7; rhTarget = s.rhSet - 12; }
  if (s.fault === 'humidifier') { rhTarget = s.rhSet - 22; }
  if (s.fault) s.faultTicks++;
  if (s.fault === 'door' && s.faultTicks > 8) { s.fault = null; logEvent('sensor', `${loc.name}: door closed automatically`); }

  s.door = s.fault === 'door';
  s.temp = s.temp + (target - s.temp) * 0.25 + noise() * 0.25;
  s.rh = Math.max(30, Math.min(100, s.rh + (rhTarget - s.rh) * 0.3 + noise() * 1.2));
}

function recordReading(s) {
  s.temp = round1(s.temp); s.rh = round1(s.rh);
  s.history.push({ t: db.simNow, temp: s.temp, rh: s.rh, door: s.door });
  if (s.history.length > HISTORY_LEN) s.history.shift();
  s.lastSeen = db.simNow;
}

function scriptedScenario() {
  // A reefer on the Saudi land route loses its compressor early in every demo run,
  // and the produce room door is left open a little later.
  if (db.tick === 8) setFault('S-06', 'compressor');
  if (db.tick === 45) setFault('S-03', 'door');
  // Background randomness: rare door-open events.
  for (const l of LOCATIONS) {
    if (l.kind === 'room' && !db.sensors[l.id].fault && rand() < 0.002) setFault(l.id, 'door');
  }
}

function setFault(sensorId, fault) {
  const s = db.sensors[sensorId];
  s.fault = fault; s.faultTicks = 0;
  if (fault) logEvent('sensor', `${locationById[sensorId].name}: ${fault} fault detected`, { severity: 'serious' });
}

function moveTruckToWarehouse(truckId, reason) {
  const moved = [];
  for (const b of db.batches) {
    if (b.locationId === truckId && b.status === 'active') {
      const room = homeRoomFor(productById[b.productId]);
      b.locationId = room.id;
      b.exposure.handlingEvents += 1;
      moved.push(`${b.id} → ${room.name.split(' — ')[0]}`);
    }
  }
  const s = db.sensors[truckId];
  s.status = 'returning'; s.fault = null; s.returnTicks = 18; s.etaH = null;
  logEvent('logistics', `${locationById[truckId].name} ${reason}. Unloaded: ${moved.join(', ') || 'nothing'}`);
}

function updateTrucks(dtH) {
  for (const l of LOCATIONS.filter(x => x.kind === 'truck')) {
    const s = db.sensors[l.id];
    if (s.status === 'in-transit') {
      s.etaH = Math.max(0, s.etaH - dtH * (s.fault ? 0.6 : 1));
      if (s.etaH <= 0) {
        moveTruckToWarehouse(l.id, 'arrived at Doha Central Cold Store');
        resolveAlert(`temp:${l.id}`, 'Truck arrived and was unloaded');
      }
    } else if (s.status === 'returning' && --s.returnTicks <= 0) {
      // A fresh inbound shipment departs.
      const load = seedTruckLoad(l.id, db.simNow);
      for (const b of load) b.initialQty = b.qty;
      db.batches.push(...load);
      s.status = 'in-transit'; s.etaH = l.etaH; s.temp = s.setpoint + 1;
      logEvent('logistics', `${l.name} departed ${l.site.split(' → ')[0]} with ${load.length} new batches`);
    }
  }
}

function detectSensorAlerts() {
  for (const l of LOCATIONS) {
    const s = db.sensors[l.id];
    if (l.kind === 'truck' && s.status !== 'in-transit') continue;
    const recent = s.history.slice(-2);
    const hot = recent.length === 2 && recent.every(r => r.temp > s.setpoint + 3);
    if (hot) {
      const critical = s.temp > s.setpoint + 6;
      raiseAlert(`temp:${l.id}`, {
        type: 'temperature', sensorId: l.id, severity: critical ? 'critical' : 'serious',
        title: `High temperature — ${l.name}`,
        message: `${s.temp} °C (setpoint ${s.setpoint} °C). Products are losing shelf life ${critical ? 'very ' : ''}fast.`,
        recommendation: l.kind === 'truck'
          ? 'Reroute to the nearest cold store (Doha Central, ~25 min) and unload into chillers.'
          : 'Check the compressor and door seals; move high-risk stock to a backup chiller.',
        actions: l.kind === 'truck' ? ['reroute', 'inspect', 'ack'] : ['adjust', 'inspect', 'ack'],
      });
    } else if (s.temp <= s.setpoint + 2) {
      resolveAlert(`temp:${l.id}`, 'Temperature back in range');
    }
    if (s.door) {
      raiseAlert(`door:${l.id}`, {
        type: 'door', sensorId: l.id, severity: 'warning', title: `Door open — ${l.name}`,
        message: 'Door has been open for more than 10 minutes.', recommendation: 'Close the door and check the strip curtain.', actions: ['adjust', 'ack'],
      });
    } else resolveAlert(`door:${l.id}`, 'Door closed');
    if (s.rh < s.rhSet - 12 || s.rh > s.rhSet + 8) {
      raiseAlert(`rh:${l.id}`, {
        type: 'humidity', sensorId: l.id, severity: 'warning', title: `Humidity out of range — ${l.name}`,
        message: `${s.rh}% RH (target ${s.rhSet}%). Produce will dehydrate and wilt.`, recommendation: 'Adjust the humidifier / check for air leaks.', actions: ['adjust', 'ack'],
      });
    } else if (Math.abs(s.rh - s.rhSet) < 6) resolveAlert(`rh:${l.id}`, 'Humidity back in range');
  }
}

function applyGrade(b) {
  const pred = b.pred;
  let grade, source, reason, action;
  const llmValid = b.llm && GRADE_ORDER.indexOf(pred.ruleGrade) <= GRADE_ORDER.indexOf(b.llm.ruleGradeAt);
  if (llmValid) {
    ({ grade, reason, action } = b.llm);
    source = 'claude';
  } else {
    ({ reason, action } = ruleExplanation({ ...pred, abuseH: round1(b.exposure.abuseH) }));
    grade = pred.ruleGrade; source = 'rules';
  }
  // Food-safety guardrail: the LLM can never keep a batch on sale that the hard rules say must be disposed.
  if (pred.ruleGrade === 'dispose' && grade !== 'dispose') { grade = 'dispose'; source = 'rules (safety guardrail)'; ({ reason, action } = ruleExplanation({ ...pred, abuseH: round1(b.exposure.abuseH) })); }
  if (b.override && GRADE_ORDER.indexOf(b.override) > GRADE_ORDER.indexOf(grade)) { grade = b.override; source = 'manager'; action = 'Manager moved batch to flash sale.'; }

  const prev = b.grade;
  Object.assign(b, { grade, gradeSource: source, reason, action });
  if (prev !== grade && b.pred.__init) logEvent('grade', `${b.id} ${productById[b.productId].name}: ${prev} → ${grade}`, { severity: grade === 'dispose' ? 'critical' : grade === 'low' ? 'serious' : 'info' });

  if (grade === 'dispose' && b.status === 'active') {
    b.status = 'disposed'; b.disposedAt = db.simNow; b.disposedQty = b.qty;
    db.stats.disposedKg += b.qty;
    raiseAlert(`dispose:${b.id}`, {
      type: 'disposal', batchId: b.id, severity: 'critical', title: `Disposed — ${productById[b.productId].name} (${b.id})`,
      message: `${b.qty} ${productById[b.productId].unit} removed from sale. ${reason}`, recommendation: 'Confirm physical disposal and log the root cause.', actions: ['ack'],
    });
    b.qty = 0;
  }
  if (grade === 'low' && b.status === 'active' && b.pred.remainingH <= 24) {
    raiseAlert(`shelf:${b.id}`, {
      type: 'shelf-life', batchId: b.id, severity: 'warning', title: `Under 24 h left — ${productById[b.productId].name} (${b.id})`,
      message: `${b.pred.remainingH} h left, ${b.qty} ${productById[b.productId].unit} still unsold on flash sale.`, recommendation: 'Donate to a food-rescue partner now while it is still safe.', actions: ['donate', 'inspect', 'ack'],
    });
  }
  if (b.exposure.abuseH >= 1.5 && b.status === 'active' && productById[b.productId].highRisk) {
    raiseAlert(`abuse:${b.id}`, {
      type: 'food-safety', batchId: b.id, severity: 'serious', title: `Temperature abuse — ${productById[b.productId].name} (${b.id})`,
      message: `${round1(b.exposure.abuseH)} h above ${productById[b.productId].maxSafeTemp} °C (limit 4 h).`, recommendation: 'Inspect the batch; sell immediately or dispose if off-odour.', actions: ['inspect', 'prioritize', 'ack'],
    });
  }
}

function updateBatches(dtH) {
  for (const b of db.batches) {
    if (b.status !== 'active') continue;
    const s = db.sensors[b.locationId];
    const p = productById[b.productId];
    if (dtH > 0) accumulateExposure(b, p, s, dtH, locationById[b.locationId].kind === 'truck');
    b.pred = { ...predict(b, p, s, model, db.simNow), __init: b.pred != null };
    applyGrade(b);
    if (b.qty <= 0 && b.status === 'active') b.status = 'sold';
  }
}

function customerTiers(user) {
  return user.accountType === 'shop' ? ['good', 'mid', 'low'] : ['good', 'low'];
}

function sendCustomerNotifications() {
  const day = new Date(db.simNow).toISOString().slice(0, 10);
  const active = db.batches.filter(b => b.status === 'active' && b.qty > 0);
  for (const u of db.users.filter(x => x.role === 'customer')) {
    for (const pref of u.prefs || []) {
      const p = productById[pref.productId];
      if (!p) continue;
      const mine = active.filter(b => b.productId === p.id);
      for (const b of mine.filter(x => x.grade === 'low')) {
        notify(u, `flash:${b.id}`, {
          kind: 'flash', productId: p.id, batchId: b.id,
          title: `🔥 ${p.name} — 50% off`,
          body: `${b.qty} ${p.unit} available at QAR ${(p.price * ROUTES.low.priceFactor).toFixed(2)}/${p.unit}. Best within ${Math.max(1, Math.floor(b.pred.remainingH))} h — buy now before it's gone.`,
        });
      }
      if (u.accountType === 'shop') {
        for (const b of mine.filter(x => x.grade === 'mid')) {
          notify(u, `mid:${b.id}`, { kind: 'wholesale', productId: p.id, batchId: b.id, title: `🏷️ Wholesale lot: ${p.name}`, body: `${b.qty} ${p.unit} at 20% off (QAR ${(p.price * 0.8).toFixed(2)}/${p.unit}), ~${Math.round(b.pred.remainingH / 24)} days of shelf life.` });
        }
      }
      const fresh = mine.filter(x => x.grade === 'good').reduce((s, b) => s + b.qty, 0);
      if (pref.frequency === 'daily' && fresh > 0) {
        notify(u, `daily:${p.id}:${day}`, { kind: 'daily', productId: p.id, title: `✅ Your daily ${p.name.toLowerCase()} is in stock`, body: `${fresh} ${p.unit} fresh available today. Tap to order your usual ${pref.qty} ${p.unit}.` });
      }
      if (fresh > 0 && fresh < Math.max(20, pref.qty * 2)) {
        notify(u, `lowstock:${p.id}:${day}`, { kind: 'lowstock', productId: p.id, title: `⚠️ Limited stock: ${p.name}`, body: `Only ${fresh} ${p.unit} of fresh stock left today.` });
      }
    }
  }
}

let aiRunning = false;
async function runAI(trigger = 'auto') {
  if (aiRunning) return { skipped: true };
  aiRunning = true;
  const started = Date.now();
  try {
    const active = db.batches.filter(b => b.status === 'active' && b.pred);
    const items = active.map(b => {
      const p = productById[b.productId];
      return {
        batchId: b.id, product: p.name, category: p.category, highRisk: !!p.highRisk,
        remainingH: b.pred.remainingH, fractionLeft: b.pred.fraction, risk: b.pred.risk,
        abuseH: round1(b.exposure.abuseH), maxTempC: round1(b.exposure.maxTemp), currentTempC: db.sensors[b.locationId].temp,
        location: locationById[b.locationId].name, ruleGrade: b.pred.ruleGrade, safetyBreach: b.pred.safetyBreach,
      };
    });
    const result = await classifyWithLLM(items);
    let changed = 0;
    if (result.results) {
      for (const r of result.results) {
        const b = active.find(x => x.id === r.batchId);
        if (!b || !GRADE_ORDER.includes(r.grade)) continue;
        const before = b.grade;
        b.llm = { grade: r.grade, reason: r.reason, action: r.action, ruleGradeAt: b.pred.ruleGrade, at: db.simNow };
        applyGrade(b);
        if (b.grade !== before) changed++;
      }
    }
    const run = { id: id('R'), at: db.simNow, trigger, source: result.source, model: result.model || null, batches: items.length, changed, error: result.error || null, ms: Date.now() - started };
    db.aiRuns.unshift(run);
    db.aiRuns.length = Math.min(db.aiRuns.length, 30);
    logEvent('ai', result.source === 'claude' ? `Claude graded ${items.length} batches (${changed} changed)` : `Rule-based grading used (${result.error})`);
    return run;
  } finally {
    aiRunning = false;
  }
}

function tick() {
  const dtH = SIM_MIN_PER_TICK / 60;
  db.tick++;
  db.simNow += SIM_MIN_PER_TICK * 60_000;
  scriptedScenario();
  for (const l of LOCATIONS) {
    const s = db.sensors[l.id];
    simulateSensor(s, l);
    recordReading(s);
  }
  updateTrucks(dtH);
  detectSensorAlerts();
  updateBatches(dtH);
  sendCustomerNotifications();
  if (llmAvailable() && db.tick % AI_EVERY_TICKS === 0) runAI('auto').catch(e => console.error(e));
  if (db.tick % 6 === 0) saveDb();
}

// Warm up: prime sensor history so charts are not empty on first load.
if (db.tick === 0) {
  for (const l of LOCATIONS) for (let i = 0; i < 24; i++) {
    const s = db.sensors[l.id];
    s.temp = s.setpoint + noise() * 0.4; s.rh = s.rhSet + noise() * 2;
    s.history.push({ t: db.simNow - (24 - i) * SIM_MIN_PER_TICK * 60_000, temp: round1(s.temp), rh: round1(s.rh), door: false });
  }
}
updateBatches(0);
for (const b of db.batches) if (b.pred) b.pred.__init = true;

// ---------- HTTP API ----------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function auth(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const userId = db.sessions[token];
    const user = userId && db.users.find(u => u.id === userId);
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed for this account.' });
    req.user = user;
    next();
  };
}

function startSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  return { token, user: publicUser(user) };
}

app.post('/api/auth/signup', (req, res) => {
  const { email, password, name, phone, accountType, businessName, area, prefs, managerCode } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'An account with this email already exists.' });
  const role = accountType === 'manager' ? 'manager' : 'customer';
  if (role === 'manager' && managerCode !== MANAGER_CODE) return res.status(403).json({ error: 'Invalid warehouse access code.' });
  const validPrefs = (Array.isArray(prefs) ? prefs : [])
    .filter(p => productById[p.productId])
    .map(p => ({ productId: p.productId, frequency: ['daily', 'weekly', 'occasionally'].includes(p.frequency) ? p.frequency : 'weekly', qty: Math.max(1, Number(p.qty) || 1) }));
  const { salt, hash } = hashPassword(password);
  const user = {
    id: id('U'), email: email.trim(), name: name.trim(), phone: phone || '', role, accountType: role === 'manager' ? 'manager' : (accountType || 'household'),
    businessName: businessName || '', area: area || '', prefs: validPrefs, createdAt: db.simNow, notifiedKeys: [], salt, hash,
  };
  db.users.push(user);
  sendCustomerNotifications();
  saveDb();
  res.json(startSession(user));
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !checkPassword(String(password || ''), user)) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json(startSession(user));
});

app.post('/api/auth/logout', auth(), (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  delete db.sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/me/prefs', auth('customer'), (req, res) => {
  const prefs = (req.body?.prefs || []).filter(p => productById[p.productId]).map(p => ({ productId: p.productId, frequency: p.frequency || 'weekly', qty: Math.max(1, Number(p.qty) || 1) }));
  req.user.prefs = prefs;
  sendCustomerNotifications();
  res.json({ user: publicUser(req.user) });
});

app.get('/api/meta', (req, res) => {
  res.json({ categories: CATEGORIES, products: PRODUCTS, routes: ROUTES, locations: LOCATIONS, simMinutesPerTick: SIM_MIN_PER_TICK, tickMs: TICK_MS });
});

app.get('/api/catalog', auth('customer'), (req, res) => {
  const tiers = customerTiers(req.user);
  const products = PRODUCTS.map(p => {
    const batches = db.batches.filter(b => b.productId === p.id && b.status === 'active' && b.qty > 0);
    const offers = {};
    for (const t of tiers) {
      const bs = batches.filter(b => b.grade === t);
      const qty = bs.reduce((s, b) => s + b.qty, 0);
      if (qty > 0) offers[t] = { qty, price: +(p.price * ROUTES[t].priceFactor).toFixed(2), bestWithinH: Math.floor(Math.min(...bs.map(b => b.pred.remainingH))), maxShelfDays: Math.round(Math.max(...bs.map(b => b.pred.remainingH)) / 24) };
    }
    return { ...p, offers };
  });
  res.json({ simNow: db.simNow, tiers, products });
});

app.post('/api/orders', auth('customer'), (req, res) => {
  const { productId, tier = 'good' } = req.body || {};
  const qty = Number(req.body?.qty);
  const p = productById[productId];
  if (!p) return res.status(400).json({ error: 'Unknown product.' });
  if (!customerTiers(req.user).includes(tier)) return res.status(403).json({ error: 'This offer is not available for your account type.' });
  if (!(qty > 0)) return res.status(400).json({ error: 'Enter a quantity greater than zero.' });
  // First-expired-first-out allocation within the chosen tier.
  const batches = db.batches.filter(b => b.productId === p.id && b.status === 'active' && b.grade === tier && b.qty > 0).sort((a, b) => a.pred.remainingH - b.pred.remainingH);
  const available = batches.reduce((s, b) => s + b.qty, 0);
  if (available < qty) return res.status(409).json({ error: `Only ${available} ${p.unit} available in this offer.` });
  let left = qty;
  const allocations = [];
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(b.qty, left);
    b.qty = round1(b.qty - take); left = round1(left - take);
    allocations.push({ batchId: b.id, qty: take });
    if (b.qty <= 0) b.status = 'sold';
  }
  const unitPrice = +(p.price * ROUTES[tier].priceFactor).toFixed(2);
  const order = { id: id('O'), userId: req.user.id, customer: req.user.businessName || req.user.name, accountType: req.user.accountType, productId: p.id, productName: p.name, unit: p.unit, tier, qty, unitPrice, total: +(unitPrice * qty).toFixed(2), allocations, at: db.simNow, status: 'confirmed' };
  db.orders.unshift(order);
  db.stats[tier === 'low' ? 'flashSoldKg' : tier === 'mid' ? 'midSoldKg' : 'freshSoldKg'] += qty;
  logEvent('order', `${order.customer} ordered ${qty} ${p.unit} ${p.name} (${ROUTES[tier].label})`);
  saveDb();
  res.json({ order });
});

app.get('/api/orders', auth('customer'), (req, res) => res.json({ orders: db.orders.filter(o => o.userId === req.user.id) }));

app.get('/api/notifications', auth(), (req, res) => {
  const list = db.notifications.filter(n => n.userId === req.user.id).slice(0, 50);
  res.json({ notifications: list, unread: list.filter(n => !n.read).length, simNow: db.simNow });
});
app.post('/api/notifications/read', auth(), (req, res) => {
  for (const n of db.notifications) if (n.userId === req.user.id) n.read = true;
  res.json({ ok: true });
});

// ----- manager -----

function kpis() {
  const active = db.batches.filter(b => b.status === 'active');
  const sum = arr => Math.round(arr.reduce((s, b) => s + b.qty, 0));
  const byGrade = Object.fromEntries(GRADE_ORDER.map(g => [g, 0]));
  for (const b of active) byGrade[b.grade] += b.qty;
  byGrade.dispose = Math.round(db.stats.disposedKg);
  let inRange = 0, total = 0;
  for (const s of Object.values(db.sensors)) for (const r of s.history) { total++; if (Math.abs(r.temp - s.setpoint) <= 2) inRange++; }
  const saved = db.stats.flashSoldKg + db.stats.midSoldKg + db.stats.donatedKg;
  return {
    activeBatches: active.length,
    stockKg: sum(active),
    atRiskKg: sum(active.filter(b => b.grade === 'low' || b.grade === 'mid')),
    disposedKg: Math.round(db.stats.disposedKg),
    rescuedKg: Math.round(saved),
    openAlerts: db.alerts.filter(a => a.status === 'open').length,
    criticalAlerts: db.alerts.filter(a => a.status === 'open' && a.severity === 'critical').length,
    compliancePct: total ? Math.round((inRange / total) * 100) : 100,
    byGrade: Object.fromEntries(Object.entries(byGrade).map(([k, v]) => [k, Math.round(v)])),
    ordersToday: db.orders.length,
  };
}

app.get('/api/manager/overview', auth('manager'), (req, res) => {
  const batches = db.batches
    .filter(b => b.status === 'active' || (b.status === 'disposed' && db.simNow - b.disposedAt < 24 * 3.6e6))
    .map(b => ({ ...b, llm: undefined, product: productById[b.productId], location: locationById[b.locationId].name, locationKind: locationById[b.locationId].kind }));
  res.json({
    simNow: db.simNow, tick: db.tick,
    kpis: kpis(),
    sensors: LOCATIONS.map(l => ({ ...l, ...db.sensors[l.id], batchCount: db.batches.filter(b => b.locationId === l.id && b.status === 'active').length })),
    batches,
    alerts: db.alerts.filter(a => a.status !== 'resolved' || db.simNow - a.resolvedAt < 6 * 3.6e6).slice(0, 60),
    events: db.events.slice(0, 40),
    orders: db.orders.slice(0, 25),
    aiRuns: db.aiRuns.slice(0, 10),
    ai: { available: llmAvailable(), model: llmModel, running: aiRunning },
    mlModel: { r2: +model.r2.toFixed(3), rmse: +model.rmse.toFixed(3), trainSize: model.trainSize, testSize: model.testSize, weights: model.weights.map(w => +w.toFixed(4)), featureNames: model.featureNames },
    routes: ROUTES,
  });
});

app.post('/api/manager/ai/run', auth('manager'), async (req, res) => {
  const run = await runAI('manual');
  saveDb();
  res.json({ run });
});

function batchAction(b, action, note) {
  const p = productById[b.productId];
  switch (action) {
    case 'inspect':
      b.exposure.handlingEvents += 1; b.inspectedAt = db.simNow;
      logEvent('action', `Inspection logged for ${b.id} ${p.name}`);
      return 'Inspection logged.';
    case 'prioritize':
      b.override = 'low'; applyGrade(b);
      logEvent('action', `${b.id} ${p.name} moved to flash sale by manager`);
      return 'Moved to flash sale — matching customers are being notified.';
    case 'donate': {
      if (b.pred.safetyBreach || b.grade === 'dispose') throw new Error('Not safe to donate — food-safety breach.');
      db.stats.donatedKg += b.qty;
      logEvent('action', `${b.qty} ${p.unit} of ${p.name} (${b.id}) redirected to a food-rescue charity`);
      b.status = 'donated'; b.qty = 0;
      resolveAlert(`shelf:${b.id}`, 'Donated');
      return 'Batch redirected to food-rescue partner.';
    }
    case 'dispose':
      b.override = 'dispose'; applyGrade(b);
      return 'Batch disposed.';
    default:
      throw new Error(`Unknown action ${action}${note ? '' : ''}`);
  }
}

function sensorAction(sensorId, action) {
  const l = locationById[sensorId];
  const s = db.sensors[sensorId];
  switch (action) {
    case 'reroute':
      if (l.kind !== 'truck') throw new Error('Only trucks can be rerouted.');
      moveTruckToWarehouse(sensorId, 'rerouted to the nearest cold store');
      resolveAlert(`temp:${sensorId}`, 'Rerouted and unloaded');
      return 'Truck rerouted — stock unloaded into the correct chillers.';
    case 'adjust':
      s.fault = null; s.door = false;
      logEvent('action', `${l.name}: technician dispatched, conditions being restored`);
      return 'Technician dispatched; setpoint restored.';
    case 'inspect':
      logEvent('action', `${l.name}: inspection requested`);
      return 'Inspection requested.';
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

app.post('/api/manager/alerts/:id/action', auth('manager'), (req, res) => {
  const alert = db.alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found.' });
  const { action } = req.body || {};
  try {
    let message = 'Acknowledged.';
    if (action !== 'ack') {
      if (alert.batchId) message = batchAction(db.batches.find(b => b.id === alert.batchId), action);
      else if (alert.sensorId) message = sensorAction(alert.sensorId, action);
    }
    if (alert.status === 'open') { alert.status = 'acknowledged'; alert.ackBy = req.user.name; alert.note = message; }
    updateBatches(0);
    saveDb();
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/manager/batches/:id/action', auth('manager'), (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  if (!b || b.status !== 'active') return res.status(404).json({ error: 'Batch not found.' });
  try {
    const message = batchAction(b, req.body?.action);
    saveDb();
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Demo helper: inject a fault so the judges can watch the pipeline react.
app.post('/api/manager/sensors/:id/fault', auth('manager'), (req, res) => {
  if (!db.sensors[req.params.id]) return res.status(404).json({ error: 'Sensor not found.' });
  const fault = req.body?.fault || null;
  if (fault && !['compressor', 'door', 'humidifier'].includes(fault)) return res.status(400).json({ error: 'Unknown fault.' });
  setFault(req.params.id, fault);
  res.json({ ok: true });
});

app.post('/api/manager/reset', auth('manager'), (req, res) => {
  const keepUsers = db.users;
  db = freshDb();
  // Keep accounts that were created during the demo.
  for (const u of keepUsers) if (!db.users.some(x => x.email === u.email)) db.users.push({ ...u, notifiedKeys: [] });
  const token = crypto.randomBytes(24).toString('hex');
  const me = db.users.find(u => u.email === req.user.email);
  db.sessions[token] = me.id;
  updateBatches(0);
  for (const b of db.batches) if (b.pred) b.pred.__init = true;
  saveDb();
  res.json({ ok: true, token });
});

// ----- sensor ingestion pipeline (for real IoT gateways) -----
// POST /api/ingest  { "sensorId": "S-01", "temp": 3.4, "rh": 87, "door": false }
app.post('/api/ingest', (req, res) => {
  if (req.headers['x-api-key'] !== INGEST_KEY) return res.status(401).json({ error: 'Invalid ingest key.' });
  const readings = Array.isArray(req.body) ? req.body : [req.body];
  let accepted = 0;
  for (const r of readings) {
    const s = db.sensors[r?.sensorId];
    if (!s || typeof r.temp !== 'number') continue;
    s.temp = r.temp; if (typeof r.rh === 'number') s.rh = r.rh; s.door = !!r.door;
    s.externalTick = db.tick;
    accepted++;
  }
  res.json({ accepted });
});

app.get('/api/health', (req, res) => res.json({ ok: true, tick: db.tick, simNow: db.simNow, claude: llmAvailable() }));

app.get('/{*splat}', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  FreshRoute running →  http://localhost:${PORT}`);
  console.log(`  Claude grading: ${llmAvailable() ? `ON (${llmModel})` : 'OFF — set ANTHROPIC_API_KEY to enable (rule-based fallback active)'}`);
  console.log(`  ML correction model: R² ${model.r2.toFixed(3)} on ${model.testSize} held-out batches`);
  console.log(`  1 sensor reading every ${TICK_MS / 1000}s = ${SIM_MIN_PER_TICK} simulated minutes\n`);
  setInterval(tick, TICK_MS);
  if (llmAvailable()) setTimeout(() => runAI('startup').catch(console.error), 2000);
});
