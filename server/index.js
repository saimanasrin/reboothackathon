// FreshRoute server: REST API + sensor pipeline + AI grading + simulation loop + static frontend.
//
// Data flow (mirrors how a Qatari cold store collects data):
//   1. Shipping notice (ASN, electronic) from the supplier: product GTIN, lot, SSCC, origin, harvest date, qty
//   2. MoPH Port Health clearance at Hamad Port / Abu Samra
//   3. Reefer truck telemetry in transit: temperature, humidity, compressor status, GPS
//   4. Dock receiving by the receiving clerk: scan SSCC, probe temperature, condition, accept/reject
//   5. In storage: room sensors (temp, humidity, door) + a freshness tag on each pallet (CO₂, ethylene, ammonia/VOC, shock)
//   6. QA inspections by the QA inspector (sensory score, probe temperature) — also training labels for the AI
//   7. AI: anomaly detection → hybrid ML shelf life + learned thresholds → 3 Claude agents → grade → routing
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, PRODUCTS, LOCATIONS, ROUTES, GRADE_ORDER, productById, locationById, homeRoomFor } from './catalog.js';
import { trainModels, predict, stepBatch, tagGas, gasAge, detectAnomalies, newExposure, hiddenFactor, tagGain, GAS_NAMES } from './model.js';
import { runClaudeAgents, ruleAnalyst, ruleSafety, ruleDecision, llmAvailable, llmModel } from './agents.js';

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
const TAG_HISTORY_LEN = 72;
const AUTO_RECEIVE_TICKS = 12;
const HOUR = 3.6e6;

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
const pick = arr => arr[Math.floor(rand() * arr.length)];

function gs1Check(digits) {
  const sum = [...digits].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}
function newSscc() {
  const body = `0630${String(Math.floor(rand() * 1e13)).padStart(13, '0')}`;
  return body + gs1Check(body);
}

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

// ---------- AI models (trained on start-up) ----------

const t0 = Date.now();
const model = trainModels(mulberry32(42));
console.log(`  AI models trained in ${Date.now() - t0} ms`);

// ---------- state ----------

let db;
let batchCounter = 1000;

const SUPPLIERS = {
  meat: [['Australia', 'Hamad Port'], ['Brazil', 'Hamad Port'], ['Local farm — Al Khor', null], ['Saudi Arabia', 'Abu Samra Land Border']],
  dairy: [['Local dairy — Al Khor', null], ['Saudi Arabia', 'Abu Samra Land Border'], ['Turkey', 'Hamad Port']],
  vegetables: [['Local greenhouse — Al Shahaniya', null], ['Jordan', 'Abu Samra Land Border'], ['Netherlands', 'Hamad Port']],
  fruits: [['Egypt', 'Hamad Port'], ['India', 'Hamad Port'], ['Spain', 'Hamad Port'], ['Philippines', 'Hamad Port']],
};

function makeBatch(productId, locationId, simNow, opts = {}) {
  const p = productById[productId];
  const frac = opts.usedFrac ?? 0.05 + rand() * 0.25;
  const factor = opts.factor ?? hiddenFactor(rand);
  const [origin, clearance] = opts.origin ?? pick(SUPPLIERS[p.category]);
  const preAgeH = p.baseShelfH * frac;
  const d = new Date(simNow);
  return {
    id: `B-${++batchCounter}`,
    productId,
    gtin: p.gtin,
    lot: `L${String(d.getFullYear()).slice(2)}${String(Math.floor(rand() * 900) + 100)}-${batchCounter % 100}`,
    sscc: newSscc(),
    origin,
    clearance: clearance ? { by: `MoPH Port Health — ${clearance}`, status: 'cleared', at: simNow - (6 + rand() * 18) * HOUR } : { by: 'Local producer — MoPH licensed', status: 'n/a', at: null },
    harvestedAt: simNow - preAgeH * HOUR,
    locationId,
    stage: locationById[locationId].kind === 'truck' ? 'transit' : 'stored',
    qty: opts.qty ?? Math.round(20 + rand() * 180),
    initialQty: 0,
    createdAt: simNow,
    preAgeH,
    lifeUsedH: preAgeH,
    trueUsedH: Math.min(preAgeH * factor, p.baseShelfH * 0.85),
    hidden: { factor, gain: tagGain(rand) },
    exposure: newExposure({ transitH: opts.transitH ?? 12, maxTemp: p.idealTemp, ...opts.exposure }),
    tagHistory: [],
    receipt: opts.receipt ?? null,
    inspection: null,
    status: 'active',
    grade: 'good', gradeSource: 'rules', reason: '', action: '', confidence: 'medium',
    agents: null, claude: null, override: null, anomalies: [], pred: null,
  };
}

function seedTruckLoad(truckId, simNow) {
  const loads = {
    'S-05': ['strawberry', 'chicken', 'milk', 'spinach'],
    'S-06': ['tomato', 'lamb', 'yogurt', 'cucumber'],
  };
  const truck = locationById[truckId];
  const origin = [truck.id === 'S-05' ? 'Netherlands' : 'Saudi Arabia', truck.clearance];
  const batches = loads[truckId].map(pid => makeBatch(pid, truckId, simNow, { usedFrac: 0.06 + rand() * 0.12, origin, transitH: 6 + rand() * 30 }));
  for (const b of batches) b.initialQty = b.qty;
  const shipment = {
    asn: `ASN-${String(Math.floor(rand() * 9e5) + 1e5)}`,
    supplier: `${origin[0]} exporter`,
    origin: origin[0],
    clearance: { by: `MoPH Port Health — ${truck.clearance}`, status: 'cleared', at: simNow },
    departedAt: simNow,
    batchIds: batches.map(b => b.id),
  };
  return { batches, shipment };
}

function freshDb() {
  const simNow = Date.now();
  batchCounter = 1000;
  const sensors = {};
  for (const l of LOCATIONS) {
    sensors[l.id] = {
      id: l.id, temp: l.setpoint + noise() * 0.3, rh: l.rhSet, door: false, online: true,
      setpoint: l.setpoint, rhSet: l.rhSet, fault: null, faultTicks: 0,
      compressor: 'on', gps: l.from ?? null,
      etaH: l.etaH ?? null, status: l.kind === 'truck' ? 'in-transit' : 'ok',
      history: [], externalTick: -99, shipment: null,
    };
  }
  const batches = [];
  // Stock already received and stored in the rooms, spread across the freshness range.
  const usedFracs = [0.1, 0.2, 0.35, 0.5, 0.62, 0.72];
  for (const p of PRODUCTS) {
    const room = homeRoomFor(p);
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const b = makeBatch(p.id, room.id, simNow, { usedFrac: pick(usedFracs) + noise() * 0.04, factor: 0.85 + rand() * 0.3 });
      b.receipt = { probeTemp: round1(p.idealTemp + rand() * 1.5), condition: 'ok', by: 'Receiving clerk', at: simNow - rand() * 48 * HOUR, auto: false };
      batches.push(b);
    }
  }
  // Scripted cases for the demo:
  // (1) temperature history is perfect but the lamb was poorly pre-cooled at origin — only the ammonia/VOC tag reveals it.
  const lamb = makeBatch('lamb', 'S-01', simNow, { usedFrac: 0.28, factor: 2.4, origin: ['Brazil', 'Hamad Port'], qty: 140 });
  lamb.trueUsedH = lamb.preAgeH * 2.4;
  lamb.receipt = { probeTemp: 1.4, condition: 'ok', by: 'Receiving clerk', at: simNow - 20 * HOUR, auto: false };
  // (2) beef mince that sat in a warm container at the port — a food-safety breach.
  const mince = makeBatch('beef-mince', 'S-01', simNow, { usedFrac: 0.3, factor: 1.1, origin: ['Brazil', 'Hamad Port'], qty: 60, exposure: { abuseH: 4.5, maxTemp: 9.8, excessDegH: 40, handlingEvents: 3 } });
  mince.receipt = { probeTemp: 7.8, condition: 'ok', by: 'Receiving clerk', at: simNow - 10 * HOUR, auto: false };
  batches.push(lamb, mince);
  const trucks = {};
  for (const tId of ['S-05', 'S-06']) {
    const { batches: load, shipment } = seedTruckLoad(tId, simNow);
    trucks[tId] = shipment;
    batches.push(...load);
  }
  // (3) strawberries on the port truck were dropped at loading — bruised, will spoil early.
  const straw = batches.find(b => b.productId === 'strawberry' && b.locationId === 'S-05');
  if (straw) { straw.hidden.factor = 1.9; straw.exposure.shocks = 3; straw.trueUsedH += 0.12 * productById.strawberry.baseShelfH; }
  for (const b of batches) b.initialQty = b.qty;
  for (const [tId, sh] of Object.entries(trucks)) sensors[tId].shipment = sh;

  const users = [];
  const addUser = (u, pw) => { const { salt, hash } = hashPassword(pw); users.push({ id: id('U'), createdAt: simNow, notifiedKeys: [], salt, hash, ...u }); };
  addUser({ email: 'manager@example.com', name: 'Warehouse Manager', role: 'manager', phone: '+974 5000 0000', businessName: 'Doha Central Cold Store', area: 'Industrial Area', accountType: 'manager', prefs: [] }, 'manager123');
  addUser({ email: 'chef@example.com', name: 'Chef Omar', role: 'customer', accountType: 'restaurant', businessName: 'Corniche Grill', area: 'West Bay', phone: '+974 5555 1234', prefs: [{ productId: 'chicken', frequency: 'daily', qty: 40 }, { productId: 'tomato', frequency: 'daily', qty: 15 }, { productId: 'lamb', frequency: 'weekly', qty: 20 }] }, 'demo123');
  addUser({ email: 'hotel@example.com', name: 'Layla', role: 'customer', accountType: 'hotel', businessName: 'Pearl Bay Hotel Kitchen', area: 'The Pearl', phone: '+974 5555 9876', prefs: [{ productId: 'strawberry', frequency: 'daily', qty: 10 }, { productId: 'milk', frequency: 'daily', qty: 40 }, { productId: 'hammour', frequency: 'weekly', qty: 15 }] }, 'demo123');
  addUser({ email: 'shop@example.com', name: 'Ahmed', role: 'customer', accountType: 'shop', businessName: 'Al Rayyan Mini Mart', area: 'Al Rayyan', phone: '+974 5555 4455', prefs: [{ productId: 'banana', frequency: 'daily', qty: 30 }, { productId: 'laban', frequency: 'daily', qty: 50 }, { productId: 'yogurt', frequency: 'weekly', qty: 20 }] }, 'demo123');

  return {
    version: 2, simNow, tick: 0, sensors, batches, users, sessions: {}, alerts: [], orders: [],
    notifications: [], events: [], aiRuns: [], inspections: [],
    stats: { disposedKg: 0, flashSoldKg: 0, midSoldKg: 0, freshSoldKg: 0, donatedKg: 0, rejectedKg: 0 },
  };
}

function loadDb() {
  if (!process.argv.includes('--reset') && fs.existsSync(DB_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (loaded.version === 2) {
        batchCounter = Math.max(1000, ...loaded.batches.map(b => Number(b.id.split('-')[1]) || 0));
        console.log(`  Loaded state from ${path.relative(ROOT, DB_FILE)}`);
        return loaded;
      }
      console.log('  Saved state is from an older version, starting fresh');
    } catch (e) {
      console.warn('  Could not read saved state, starting fresh:', e.message);
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

// ---------- location sensors ----------

function simulateSensor(s, loc) {
  if (db.tick - s.externalTick < 3) return; // a real sensor is pushing data; don't simulate
  if (loc.kind === 'truck' && s.status === 'returning') { s.temp += (s.setpoint - s.temp) * 0.3; return; }

  let target = s.setpoint;
  let rhTarget = s.rhSet;
  // Qatar ambient is 40 °C+, so a dead reefer warms steadily.
  if (s.fault === 'compressor') { target = 8 + Math.min(14, s.faultTicks * 0.3); rhTarget = s.rhSet - 18; }
  if (s.fault === 'door') { target = s.setpoint + 7; rhTarget = s.rhSet - 12; }
  if (s.fault === 'humidifier') { rhTarget = s.rhSet - 22; }
  if (s.fault) s.faultTicks++;
  if (s.fault === 'door' && s.faultTicks > 8) { s.fault = null; logEvent('sensor', `${loc.name}: door closed`); }

  s.door = s.fault === 'door';
  if (s.status !== 'at-dock') s.compressor = s.fault === 'compressor' ? 'fault' : 'on';
  s.temp = s.temp + (target - s.temp) * 0.25 + noise() * 0.25;
  s.rh = Math.max(30, Math.min(100, s.rh + (rhTarget - s.rh) * 0.3 + noise() * 1.2));
  if (loc.kind === 'truck' && s.status === 'in-transit') {
    const progress = 1 - Math.max(0, s.etaH) / loc.etaH;
    s.gps = [0, 1].map(i => +(loc.from[i] + (loc.to[i] - loc.from[i]) * progress).toFixed(4));
  }
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
  for (const l of LOCATIONS) {
    if (l.kind === 'room' && !db.sensors[l.id].fault && rand() < 0.002) setFault(l.id, 'door');
  }
}

function setFault(sensorId, fault) {
  const s = db.sensors[sensorId];
  s.fault = fault; s.faultTicks = 0;
  if (fault) logEvent('sensor', `${locationById[sensorId].name}: ${fault} fault`, { severity: 'serious' });
}

// ---------- trucks, dock and receiving ----------

function arriveAtDock(truckId, reason) {
  const s = db.sensors[truckId];
  s.status = 'at-dock'; s.etaH = 0; s.dockTicks = 0; s.gps = locationById[truckId].to;
  if (s.fault === 'compressor') { s.fault = null; s.compressor = 'shore power'; }
  for (const b of db.batches) if (b.locationId === truckId && b.status === 'active') b.stage = 'dock';
  logEvent('logistics', `${locationById[truckId].name} ${reason} — waiting for receiving (ASN ${s.shipment?.asn})`);
  raiseAlert(`dock:${truckId}`, {
    type: 'receiving', sensorId: truckId, severity: 'warning', title: `Truck at dock — ${locationById[truckId].name}`,
    message: `${s.shipment?.batchIds.length || 0} pallets waiting. Scan, probe and put away before they warm up.`,
    recommendation: 'Open Receiving: scan pallets, record probe temperatures, accept or reject.', actions: ['receive'],
  });
}

// lines: [{ batchId, probeTemp, condition: 'ok'|'damaged'|'off-odour', accept }]
function receiveTruck(truckId, lines, by, auto = false) {
  const s = db.sensors[truckId];
  if (s.status !== 'at-dock') throw new Error('This truck is not at the dock.');
  const summary = [];
  for (const b of db.batches.filter(x => x.locationId === truckId && x.status === 'active')) {
    const p = productById[b.productId];
    const line = lines.find(l => l.batchId === b.id) ?? {};
    const probeTemp = Number.isFinite(Number(line.probeTemp)) && line.probeTemp !== '' ? Number(line.probeTemp) : round1(b.tagHistory.at(-1)?.temp ?? s.temp);
    const condition = line.condition || 'ok';
    const accept = line.accept !== false && condition !== 'off-odour';
    b.receipt = { probeTemp, condition, by, at: db.simNow, auto };
    b.exposure.handlingEvents += 1;
    if (!accept) {
      b.status = 'rejected'; db.stats.rejectedKg += b.qty;
      summary.push(`${b.id} rejected (${condition})`);
      continue;
    }
    if (condition === 'damaged') { b.exposure.shocks += 1; if (p.shockSensitive) b.trueUsedH += 0.05 * p.baseShelfH; }
    const room = homeRoomFor(p);
    b.locationId = room.id; b.stage = 'stored';
    summary.push(`${b.id} → ${room.name.split(' — ')[0]}${probeTemp > p.maxSafeTemp ? ` (probe ${probeTemp} °C!)` : ''}`);
  }
  s.status = 'returning'; s.returnTicks = 18; s.etaH = null; s.compressor = 'on';
  resolveAlert(`dock:${truckId}`, auto ? 'Auto-received' : `Received by ${by}`);
  resolveAlert(`temp:${truckId}`, 'Unloaded');
  resolveAlert(`reefer:${truckId}`, 'Unloaded');
  logEvent('receiving', `${auto ? 'Auto-received' : `Received by ${by}`}: ${locationById[truckId].name} — ${summary.join(', ')}`);
  return summary;
}

function updateTrucks(dtH) {
  for (const l of LOCATIONS.filter(x => x.kind === 'truck')) {
    const s = db.sensors[l.id];
    if (s.status === 'in-transit') {
      s.etaH = Math.max(0, s.etaH - dtH * (s.fault ? 0.6 : 1));
      if (s.etaH <= 0) arriveAtDock(l.id, 'arrived at Doha Central Cold Store');
    } else if (s.status === 'at-dock' && ++s.dockTicks >= AUTO_RECEIVE_TICKS) {
      receiveTruck(l.id, [], 'Receiving clerk (auto)', true);
    } else if (s.status === 'returning' && --s.returnTicks <= 0) {
      const { batches, shipment } = seedTruckLoad(l.id, db.simNow);
      db.batches.push(...batches);
      for (const b of batches) warmUpTags(b);
      s.shipment = shipment;
      s.status = 'in-transit'; s.etaH = l.etaH; s.temp = s.setpoint + 1; s.gps = l.from;
      logEvent('logistics', `${l.name} departed ${l.site.split(' → ')[0]} — ASN ${shipment.asn}, ${batches.length} pallets, cleared by ${shipment.clearance.by}`);
    }
  }
}

function detectSensorAlerts() {
  for (const l of LOCATIONS) {
    const s = db.sensors[l.id];
    if (l.kind === 'truck' && s.status === 'returning') continue;
    if (l.kind === 'truck' && s.compressor === 'fault') {
      raiseAlert(`reefer:${l.id}`, {
        type: 'reefer', sensorId: l.id, severity: 'critical', title: `Reefer compressor fault — ${l.name}`,
        message: `Reefer unit reports a compressor fault. At Qatar's 40 °C+ ambient the load will warm quickly (now ${s.temp} °C).`,
        recommendation: 'Reroute to the nearest cold store now and plug into shore power; unload into chillers.', actions: ['reroute', 'ack'],
      });
    }
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
        actions: l.kind === 'truck' ? ['reroute', 'ack'] : ['adjust', 'ack'],
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

// ---------- pallet freshness tags ----------

function readTag(b, shock) {
  const p = productById[b.productId];
  const s = db.sensors[b.locationId];
  const temp = round1(s.temp + noise() * 0.3);
  const rh = round1(s.rh + noise() * 1.5);
  const external = b.externalTag && db.tick - b.externalTag.tick < 3 ? b.externalTag : null;
  const gas = external ?? tagGas(p, b.trueUsedH / p.baseShelfH, temp, rand, b.hidden.gain);
  b.tagHistory.push({ t: db.simNow, temp, rh, co2: gas.co2, eth: gas.eth, voc: gas.voc, shock: !!shock });
  if (b.tagHistory.length > TAG_HISTORY_LEN) b.tagHistory.shift();
}

function warmUpTags(b) {
  // Pallet tags have been logging since loading; give each one a short history.
  const saved = db.simNow;
  for (let i = 12; i > 0; i--) { db.simNow = saved - i * SIM_MIN_PER_TICK * 60_000; readTag(b, false); }
  db.simNow = saved;
}

// ---------- AI grading ----------

function ageOf(b) { return b.preAgeH + (db.simNow - b.createdAt) / HOUR; }

function locationIssues(b) {
  const l = locationById[b.locationId], s = db.sensors[l.id];
  const out = [];
  if (s.compressor === 'fault') out.push(`${l.name} reefer compressor fault`);
  if (s.door) out.push(`${l.name} door open`);
  if (s.temp > s.setpoint + 3) out.push(`${l.name} at ${s.temp} °C vs setpoint ${s.setpoint} °C`);
  return out;
}

function buildAgentCase(b) {
  const p = productById[b.productId];
  const l = locationById[b.locationId], s = db.sensors[l.id];
  const now = b.tagHistory.at(-1), past = b.tagHistory.at(-7) ?? b.tagHistory[0];
  const delta = k => (now && past ? +(now[k] - past[k]).toFixed(k === 'eth' ? 3 : 1) : 0);
  const pred = b.pred;
  return {
    batchId: b.id,
    analystInput: {
      batchId: b.id, product: p.name, category: p.category, location: l.name, stage: b.stage,
      readingsNow: now ? { tempC: now.temp, rhPct: now.rh, co2ppm: now.co2, ethylenePpm: now.eth, ammoniaVocPpm: now.voc } : null,
      changeLastHour: { tempC: delta('temp'), co2ppm: delta('co2'), ethylenePpm: delta('eth'), ammoniaVocPpm: delta('voc') },
      freshLevels: { co2ppm: p.gas.co2[0], ethylenePpm: p.gas.eth[0], ammoniaVocPpm: p.gas.voc[0] },
      shocksTotal: b.exposure.shocks, reeferStatus: l.kind === 'truck' ? s.compressor : undefined,
      anomalies: b.anomalies,
      primaryGas: GAS_NAMES[p.gas.primary], gasAge: pred.gasAge,
      physicsLifeUsed: +(1 - pred.physicsH / p.baseShelfH).toFixed(2),
    },
    safetyInput: {
      batchId: b.id, product: p.name, highRisk: !!p.highRisk, maxSafeTempC: p.maxSafeTemp,
      abuseH: round1(b.exposure.abuseH), maxTempC: round1(b.exposure.maxTemp),
      voc: now?.voc ?? null, vocAge: now ? +gasAge(p, 'voc', now.voc, now.temp).toFixed(2) : 0,
      probeTempAtReceipt: b.receipt?.probeTemp ?? null,
      inspection: b.inspection ? { sensory: b.inspection.sensory, probeTemp: b.inspection.probeTemp } : null,
      remainingH: pred.remainingH,
    },
    ml: {
      remainingIdealH: pred.remainingIdealH, remainingAtCurrentConditionsH: pred.remainingH, uncertaintyH: pred.uncertaintyH,
      mlGrade: pred.mlGrade, thresholds: pred.thresholds, physicsOnlyH: pred.physicsH, physicsOnlyGrade: pred.physicsGrade,
    },
  };
}

function applyGrade(b) {
  const p = productById[b.productId];
  b.anomalies = [...locationIssues(b), ...detectAnomalies(b.tagHistory, p).map(a => a.text)];
  const c = buildAgentCase(b);
  const ra = ruleAnalyst(c), rs = ruleSafety(c);
  let agents = { source: 'rules', analyst: ra, safety: rs, decision: ruleDecision(c, ra, rs) };
  const claudeValid = b.claude && GRADE_ORDER.indexOf(b.pred.mlGrade) <= GRADE_ORDER.indexOf(b.claude.mlGradeAt);
  if (claudeValid) agents = { source: 'claude', model: b.claude.model, at: b.claude.at, analyst: b.claude.analyst ?? ra, safety: b.claude.safety ?? rs, decision: b.claude.decision };
  b.agents = agents;

  let { grade, reason, action, confidence } = agents.decision;
  let source = agents.source;
  // Guardrails that no model can override.
  if (rs.verdict === 'unsafe' && grade !== 'dispose') { grade = 'dispose'; reason = `Safety veto: ${rs.rule}`; action = 'Quarantine, dispose and log the root cause.'; source = 'safety guardrail'; }
  if (b.inspection?.sensory === 3 && GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf('low')) { grade = 'low'; reason = `QA inspection: sensory 3/5 — sell today. ${reason}`; source = 'QA inspection'; }
  if (b.override && GRADE_ORDER.indexOf(b.override) > GRADE_ORDER.indexOf(grade)) { grade = b.override; source = 'manager'; action = 'Manager moved batch to flash sale.'; }

  const prev = b.grade;
  Object.assign(b, { grade, gradeSource: source, reason, action, confidence });
  if (prev !== grade && b.pred.__init) logEvent('grade', `${b.id} ${p.name}: ${prev} → ${grade}`, { severity: grade === 'dispose' ? 'critical' : 'info' });

  if (grade === 'dispose' && b.status === 'active') {
    b.status = 'disposed'; b.disposedAt = db.simNow; b.disposedQty = b.qty;
    db.stats.disposedKg += b.qty;
    raiseAlert(`dispose:${b.id}`, {
      type: 'disposal', batchId: b.id, severity: 'critical', title: `Disposed — ${p.name} (${b.id})`,
      message: `${b.qty} ${p.unit} removed from sale. ${reason}`, recommendation: 'Confirm physical disposal and log the root cause.', actions: ['ack'],
    });
    b.qty = 0;
    return;
  }
  // The showcase alert: gas sensors caught spoilage that temperature alone would have missed.
  if (agents.analyst.concern === 'high' && GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(b.pred.physicsGrade)) {
    raiseAlert(`gas:${b.id}`, {
      type: 'ai-detection', batchId: b.id, severity: 'serious', title: `AI detected early spoilage — ${p.name} (${b.id})`,
      message: `${agents.analyst.findings} Temperature-only model says "${b.pred.physicsGrade}", AI grade "${grade}".`,
      recommendation: action, actions: ['inspect', 'prioritize', 'ack'],
    });
  }
  if (grade === 'low' && b.pred.remainingH <= 24 && b.stage === 'stored') {
    raiseAlert(`shelf:${b.id}`, {
      type: 'shelf-life', batchId: b.id, severity: 'warning', title: `Under 24 h left — ${p.name} (${b.id})`,
      message: `${b.pred.remainingH} h left, ${b.qty} ${p.unit} still unsold on flash sale.`, recommendation: 'Donate to a food-rescue partner now while it is still safe.', actions: ['donate', 'inspect', 'ack'],
    });
  }
  if (b.exposure.abuseH >= 1.5 && p.highRisk) {
    raiseAlert(`abuse:${b.id}`, {
      type: 'food-safety', batchId: b.id, severity: 'serious', title: `Temperature abuse — ${p.name} (${b.id})`,
      message: `${round1(b.exposure.abuseH)} h above ${p.maxSafeTemp} °C (limit 4 h).`, recommendation: 'Inspect the batch; sell immediately or dispose if off-odour.', actions: ['inspect', 'prioritize', 'ack'],
    });
  }
}

function updateBatches(dtH) {
  for (const b of db.batches) {
    if (b.status !== 'active') continue;
    const s = db.sensors[b.locationId];
    const p = productById[b.productId];
    const kind = locationById[b.locationId].kind;
    const shock = dtH > 0 && rand() < (kind === 'truck' && b.stage === 'transit' ? 0.04 : 0.004);
    if (dtH > 0) {
      stepBatch(b, p, s, dtH, { inTransit: b.stage === 'transit', shock, door: s.door });
      readTag(b, shock);
    }
    b.pred = { ...predict(b, p, s, model, ageOf(b)), __init: b.pred != null };
    applyGrade(b);
    if (b.qty <= 0 && b.status === 'active') b.status = 'sold';
  }
}

// ---------- customers ----------

// Business buyers only. Which grade tiers each buyer type is offered:
//   restaurants / hotels & caterers cook the same day -> fresh + flash (low)
//   small shops & middlemen resell quickly           -> fresh + wholesale (mid)
//   supermarkets need full shelf life                 -> fresh only
const BUYER_TYPES = ['restaurant', 'hotel', 'supermarket', 'shop'];
function customerTiers(user) {
  if (user.accountType === 'shop') return ['good', 'mid'];
  if (user.accountType === 'supermarket') return ['good'];
  return ['good', 'low'];
}
const sellable = b => b.status === 'active' && b.stage === 'stored' && b.qty > 0;

// Delivery: fresh and wholesale orders ride the next scheduled reefer route (06:00),
// flash orders go out on a same-day express van because the food must be used today.
const MIN_ORDER = 5;
function deliveryPlan(tier, from = db.simNow) {
  if (tier === 'low') return { type: 'express', label: 'Same-day express van', dispatchAt: from + HOUR, etaAt: from + 3 * HOUR };
  const d = new Date(from);
  d.setHours(6, 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return { type: 'scheduled', label: 'Scheduled reefer route', dispatchAt: d.getTime(), etaAt: d.getTime() + 3 * HOUR };
}
function orderStatus(o) {
  if (!o.delivery) return 'delivered';
  return db.simNow >= o.delivery.etaAt ? 'delivered' : db.simNow >= o.delivery.dispatchAt ? 'out-for-delivery' : 'confirmed';
}

function sendCustomerNotifications() {
  const day = new Date(db.simNow).toISOString().slice(0, 10);
  const active = db.batches.filter(sellable);
  for (const u of db.users.filter(x => x.role === 'customer')) {
    const tiers = customerTiers(u);
    for (const pref of u.prefs || []) {
      const p = productById[pref.productId];
      if (!p) continue;
      const mine = active.filter(b => b.productId === p.id);
      for (const b of tiers.includes('low') ? mine.filter(x => x.grade === 'low') : []) {
        notify(u, `flash:${b.id}`, {
          kind: 'flash', productId: p.id, batchId: b.id,
          title: `🔥 ${p.name} — 50% off`,
          body: `${b.qty} ${p.unit} available at QAR ${(p.price * ROUTES.low.priceFactor).toFixed(2)}/${p.unit}. Use within ${Math.max(1, Math.floor(b.pred.remainingH))} h · same-day delivery.`,
        });
      }
      if (tiers.includes('mid')) {
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

// ---------- Claude agent runs ----------

let aiRunning = false;
async function runAI(trigger = 'auto') {
  if (aiRunning) return { skipped: true };
  aiRunning = true;
  const started = Date.now();
  try {
    const active = db.batches.filter(b => b.status === 'active' && b.pred);
    const cases = active.map(buildAgentCase);
    const result = await runClaudeAgents(cases);
    let changed = 0;
    if (result.source === 'claude') {
      for (const b of active) {
        const decision = result.decision.get(b.id);
        if (!decision || !GRADE_ORDER.includes(decision.grade)) continue;
        const before = b.grade;
        b.claude = { analyst: result.analyst.get(b.id), safety: result.safety.get(b.id), decision, mlGradeAt: b.pred.mlGrade, at: db.simNow, model: result.model };
        if (b.status === 'active') applyGrade(b);
        if (b.grade !== before) changed++;
      }
    }
    const run = { id: id('R'), at: db.simNow, trigger, source: result.source, model: result.model || null, batches: cases.length, changed, error: result.error || null, ms: Date.now() - started };
    db.aiRuns.unshift(run);
    db.aiRuns.length = Math.min(db.aiRuns.length, 30);
    logEvent('ai', result.source === 'claude' ? `Claude agents graded ${cases.length} batches (${changed} changed)` : `Rule-based agents used (${result.error})`);
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

function warmUp() {
  // Prime sensor history so charts are not empty on first load.
  for (const l of LOCATIONS) for (let i = 0; i < 24; i++) {
    const s = db.sensors[l.id];
    s.temp = s.setpoint + noise() * 0.4; s.rh = s.rhSet + noise() * 2;
    s.history.push({ t: db.simNow - (24 - i) * SIM_MIN_PER_TICK * 60_000, temp: round1(s.temp), rh: round1(s.rh), door: false });
  }
  for (const b of db.batches) warmUpTags(b);
  updateBatches(0);
  for (const b of db.batches) if (b.pred) b.pred.__init = true;
}
if (db.tick === 0) warmUp();
else { updateBatches(0); for (const b of db.batches) if (b.pred) b.pred.__init = true; }

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
  if (role === 'customer' && !BUYER_TYPES.includes(accountType)) return res.status(400).json({ error: 'Choose a business type.' });
  if (role === 'customer' && !businessName) return res.status(400).json({ error: 'Business name is required.' });
  const validPrefs = (Array.isArray(prefs) ? prefs : [])
    .filter(p => productById[p.productId])
    .map(p => ({ productId: p.productId, frequency: ['daily', 'weekly', 'occasionally'].includes(p.frequency) ? p.frequency : 'weekly', qty: Math.max(1, Number(p.qty) || 1) }));
  const { salt, hash } = hashPassword(password);
  const user = {
    id: id('U'), email: email.trim(), name: name.trim(), phone: phone || '', role, accountType,
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

app.get('/api/meta', (req, res) => {
  res.json({ categories: CATEGORIES, products: PRODUCTS, routes: ROUTES, locations: LOCATIONS, gasNames: GAS_NAMES, simMinutesPerTick: SIM_MIN_PER_TICK, tickMs: TICK_MS });
});

app.get('/api/catalog', auth('customer'), (req, res) => {
  const tiers = customerTiers(req.user);
  const products = PRODUCTS.map(p => {
    const batches = db.batches.filter(b => b.productId === p.id && sellable(b));
    const offers = {};
    for (const t of tiers) {
      const bs = batches.filter(b => b.grade === t);
      const qty = bs.reduce((s, b) => s + b.qty, 0);
      if (qty > 0) offers[t] = { qty, price: +(p.price * ROUTES[t].priceFactor).toFixed(2), bestWithinH: Math.floor(Math.min(...bs.map(b => b.pred.remainingH))), maxShelfDays: Math.round(Math.max(...bs.map(b => b.pred.remainingH)) / 24), minQty: Math.min(MIN_ORDER, qty), delivery: deliveryPlan(t) };
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
  const batches = db.batches.filter(b => b.productId === p.id && sellable(b) && b.grade === tier).sort((a, b) => a.pred.remainingH - b.pred.remainingH);
  const available = batches.reduce((s, b) => s + b.qty, 0);
  if (available < qty) return res.status(409).json({ error: `Only ${available} ${p.unit} available in this offer.` });
  if (qty < Math.min(MIN_ORDER, available)) return res.status(400).json({ error: `Minimum order is ${MIN_ORDER} ${p.unit}.` });
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
  const order = { id: id('O'), userId: req.user.id, customer: req.user.businessName || req.user.name, accountType: req.user.accountType, productId: p.id, productName: p.name, unit: p.unit, tier, qty, unitPrice, total: +(unitPrice * qty).toFixed(2), allocations, at: db.simNow, delivery: deliveryPlan(tier) };
  order.status = orderStatus(order);
  db.orders.unshift(order);
  db.stats[tier === 'low' ? 'flashSoldKg' : tier === 'mid' ? 'midSoldKg' : 'freshSoldKg'] += qty;
  logEvent('order', `${order.customer} ordered ${qty} ${p.unit} ${p.name} (${ROUTES[tier].label})`);
  saveDb();
  res.json({ order });
});

app.get('/api/orders', auth('customer'), (req, res) => {
  const orders = db.orders.filter(o => o.userId === req.user.id).map(o => ({ ...o, status: orderStatus(o) }));
  res.json({ orders, simNow: db.simNow });
});

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
  return {
    activeBatches: active.length,
    atRiskKg: sum(active.filter(b => b.grade === 'low' || b.grade === 'mid')),
    disposedKg: Math.round(db.stats.disposedKg),
    rescuedKg: Math.round(db.stats.flashSoldKg + db.stats.midSoldKg + db.stats.donatedKg),
    caughtByGas: active.filter(b => GRADE_ORDER.indexOf(b.grade) > GRADE_ORDER.indexOf(b.pred.physicsGrade)).length,
    openAlerts: db.alerts.filter(a => a.status === 'open').length,
    byGrade: Object.fromEntries(Object.entries(byGrade).map(([k, v]) => [k, Math.round(v)])),
  };
}

function batchView(b, full = false) {
  const { tagHistory, hidden, trueUsedH, claude, externalTag, ...rest } = b;
  return {
    ...rest,
    product: productById[b.productId], location: locationById[b.locationId].name, locationKind: locationById[b.locationId].kind,
    tag: tagHistory.at(-1) ?? null,
    ...(full ? { tagHistory } : {}),
  };
}

function modelSummary() {
  return {
    categories: CATEGORIES.map(c => {
      const m = model.byCat[c.id];
      return { id: c.id, name: c.name, icon: c.icon, thresholds: m.thresholds, physicsThresholds: m.physicsThresholds, outcomeWindows: m.outcomeWindows, physics: m.physics, hybrid: m.hybrid, trainSize: m.trainSize, testSize: m.testSize };
    }),
    inspectionsLogged: db.inspections.length,
  };
}

app.get('/api/manager/overview', auth('manager'), (req, res) => {
  const batches = db.batches
    .filter(b => b.status === 'active' || (b.status === 'disposed' && db.simNow - b.disposedAt < 24 * HOUR))
    .map(b => batchView(b));
  res.json({
    simNow: db.simNow, tick: db.tick,
    kpis: kpis(),
    sensors: LOCATIONS.map(l => {
      const s = db.sensors[l.id];
      const here = db.batches.filter(b => b.locationId === l.id && b.status === 'active');
      return { ...l, ...s, history: s.history.slice(-48), batchCount: here.length, gasAlerts: here.filter(b => b.anomalies.some(a => /gas|CO₂|Ethylene|Ammonia/.test(a))).length };
    }),
    receiving: LOCATIONS.filter(l => l.kind === 'truck').map(l => {
      const s = db.sensors[l.id];
      return {
        truckId: l.id, name: l.name, route: l.site, status: s.status, etaH: s.etaH, dockTicks: s.dockTicks ?? 0, autoReceiveTicks: AUTO_RECEIVE_TICKS,
        shipment: s.shipment, temp: s.temp, compressor: s.compressor, gps: s.gps,
        lines: db.batches.filter(b => b.locationId === l.id && b.status === 'active').map(b => ({
          batchId: b.id, product: productById[b.productId], gtin: b.gtin, lot: b.lot, sscc: b.sscc, qty: b.qty, harvestedAt: b.harvestedAt, tagTemp: b.tagHistory.at(-1)?.temp ?? s.temp, grade: b.grade,
        })),
      };
    }),
    batches,
    alerts: db.alerts.filter(a => a.status === 'open').slice(0, 40),
    aiRuns: db.aiRuns.slice(0, 5),
    ai: { available: llmAvailable(), model: llmModel, running: aiRunning },
    model: modelSummary(),
    routes: ROUTES,
  });
});

app.get('/api/manager/batches/:id', auth('manager'), (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found.' });
  res.json({ batch: batchView(b, true), model: model.byCat[productById[b.productId].category] ? { thresholds: b.pred.thresholds, outcomeWindows: model.byCat[productById[b.productId].category].outcomeWindows } : null });
});

app.post('/api/manager/ai/run', auth('manager'), async (req, res) => {
  const run = await runAI('manual');
  saveDb();
  res.json({ run });
});

app.post('/api/manager/receiving/:truckId', auth('manager'), (req, res) => {
  try {
    const summary = receiveTruck(req.params.truckId, req.body?.lines || [], req.user.name);
    updateBatches(0);
    saveDb();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// QA inspection: sensory score 1 (spoiled) … 5 (perfect) + probe temperature.
app.post('/api/manager/batches/:id/inspection', auth('manager'), (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  if (!b || b.status !== 'active') return res.status(404).json({ error: 'Batch not found.' });
  const sensory = Math.round(Number(req.body?.sensory));
  if (!(sensory >= 1 && sensory <= 5)) return res.status(400).json({ error: 'Sensory score must be 1–5.' });
  const probeTemp = req.body?.probeTemp === '' || req.body?.probeTemp == null ? null : Number(req.body.probeTemp);
  const p = productById[b.productId];
  b.inspection = { sensory, probeTemp, notes: String(req.body?.notes || '').slice(0, 200), by: req.user.name, at: db.simNow };
  b.exposure.handlingEvents += 1;
  // Every inspection is a labelled example (prediction vs. what the inspector found) for the next retraining.
  db.inspections.push({ batchId: b.id, productId: p.id, category: p.category, predictedH: b.pred.remainingIdealH, mlGrade: b.pred.mlGrade, sensory, at: db.simNow });
  logEvent('inspection', `QA inspection ${b.id} ${p.name}: sensory ${sensory}/5${probeTemp != null ? `, probe ${probeTemp} °C` : ''}`);
  resolveAlert(`gas:${b.id}`, `Inspected: sensory ${sensory}/5`);
  resolveAlert(`abuse:${b.id}`, `Inspected: sensory ${sensory}/5`);
  applyGrade(b);
  saveDb();
  res.json({ ok: true, grade: b.grade, message: `Inspection saved. Grade is now ${b.grade}.` });
});

function batchAction(b, action) {
  const p = productById[b.productId];
  switch (action) {
    case 'prioritize':
      b.override = 'low'; applyGrade(b);
      logEvent('action', `${b.id} ${p.name} moved to flash sale by manager`);
      return 'Moved to flash sale — matching customers are being notified.';
    case 'donate': {
      if (b.agents?.safety?.donationAllowed === false || b.grade === 'dispose') throw new Error('Not safe to donate — the food-safety agent blocked it.');
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
      throw new Error(`Unknown action ${action}`);
  }
}

function sensorAction(sensorId, action) {
  const l = locationById[sensorId];
  const s = db.sensors[sensorId];
  switch (action) {
    case 'reroute':
      if (l.kind !== 'truck') throw new Error('Only trucks can be rerouted.');
      if (s.status !== 'in-transit') throw new Error('Truck is not in transit.');
      arriveAtDock(sensorId, 'rerouted to the nearest cold store (priority unloading, on shore power)');
      resolveAlert(`temp:${sensorId}`, 'Rerouted'); resolveAlert(`reefer:${sensorId}`, 'Rerouted');
      return 'Truck rerouted to the dock on shore power — receive it now.';
    case 'adjust':
      s.fault = null; s.door = false;
      logEvent('action', `${l.name}: technician dispatched, conditions being restored`);
      return 'Technician dispatched; setpoint restored.';
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
  db.sessions[token] = db.users.find(u => u.email === req.user.email).id;
  warmUp();
  saveDb();
  res.json({ ok: true, token });
});

// ----- sensor ingestion pipeline (for real IoT gateways) -----
// Location sensor:  { "sensorId": "S-01", "temp": 3.4, "rh": 87, "door": false }
// Pallet tag:       { "batchId": "B-1003", "co2": 950, "eth": 0.05, "voc": 6.2 }
app.post('/api/ingest', (req, res) => {
  if (req.headers['x-api-key'] !== INGEST_KEY) return res.status(401).json({ error: 'Invalid ingest key.' });
  const readings = Array.isArray(req.body) ? req.body : [req.body];
  let accepted = 0;
  for (const r of readings) {
    if (r?.batchId) {
      const b = db.batches.find(x => x.id === r.batchId);
      if (!b || !['co2', 'eth', 'voc'].every(k => typeof r[k] === 'number')) continue;
      b.externalTag = { co2: r.co2, eth: r.eth, voc: r.voc, tick: db.tick };
      accepted++;
      continue;
    }
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
  const acc = CATEGORIES.map(c => `${c.id} ${Math.round(model.byCat[c.id].physics.gradeAccuracy * 100)}→${Math.round(model.byCat[c.id].hybrid.gradeAccuracy * 100)}%`).join(', ');
  console.log(`\n  FreshRoute running →  http://localhost:${PORT}`);
  console.log(`  Claude agents: ${llmAvailable() ? `ON (${llmModel})` : 'OFF — set ANTHROPIC_API_KEY to enable (rule-based agents active)'}`);
  console.log(`  Grading accuracy, temperature-only → with gas sensors: ${acc}`);
  console.log(`  1 sensor reading every ${TICK_MS / 1000}s = ${SIM_MIN_PER_TICK} simulated minutes\n`);
  setInterval(tick, TICK_MS);
  if (llmAvailable()) setTimeout(() => runAI('startup').catch(console.error), 2000);
});
