// FreshRoute frontend — a dependency-free single-page app (Chart.js for charts).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtH = h => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.max(0, Math.round(h))} h`);
const qar = v => `QAR ${Number(v).toFixed(2)}`;

const GRADE = {
  good: { label: 'Good', icon: '✓' },
  mid: { label: 'Mid', icon: '◐' },
  low: { label: 'Low', icon: '!' },
  dispose: { label: 'Dispose', icon: '✕' },
};
const gradeChip = g => `<span class="chip g-${g}"><span class="dot"></span>${GRADE[g].icon} ${GRADE[g].label}</span>`;
const gradeColor = g => cssVar({ good: '--good', mid: '--warning', low: '--serious', dispose: '--critical' }[g]);

const ACCOUNT_TYPES = [
  { id: 'restaurant', icon: '🍽️', name: 'Restaurant / café', desc: 'Daily bulk orders' },
  { id: 'household', icon: '🏠', name: 'Household', desc: 'Direct customer' },
  { id: 'shop', icon: '🏪', name: 'Shop / middleman', desc: 'Wholesale & clearance lots' },
  { id: 'manager', icon: '🏭', name: 'Warehouse manager', desc: 'Needs an access code' },
];
const AREAS = ['Doha — West Bay', 'Doha — Al Sadd', 'Doha — Msheireb', 'The Pearl', 'Lusail', 'Al Rayyan', 'Al Wakrah', 'Al Khor', 'Umm Salal', 'Industrial Area', 'Other'];

const S = {
  token: localGet('fr_token'),
  user: null,
  meta: null,
  authMode: 'login',
  signup: { accountType: 'restaurant', prefs: {} },
  view: null,
  // customer
  catalog: null, catTab: null, qtyDraft: {}, orders: [], notifs: [], unread: 0, seenNotifs: null, notifOpen: false,
  // manager
  ov: null, selSensor: 'S-06', expanded: new Set(), filters: { grade: 'all', category: 'all', q: '' }, alertFilter: 'open',
  charts: {},
  pollTimer: null,
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(title, body = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5500);
}

// ===================================================================== boot

async function boot() {
  S.meta = await api('/api/meta');
  S.productById = Object.fromEntries(S.meta.products.map(p => [p.id, p]));
  if (S.token) {
    try { S.user = (await api('/api/me')).user; } catch { S.token = null; localSet('fr_token', null); }
  }
  render();
}

function setSession({ token, user }) {
  S.token = token; S.user = user; localSet('fr_token', token);
  S.view = null; S.seenNotifs = null;
  render();
}

async function logout() {
  try { if (S.token) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } }); } catch { /* ignore */ }
  S.token = null; S.user = null; localSet('fr_token', null);
  clearInterval(S.pollTimer);
  destroyCharts();
  S.authMode = 'login';
  render();
}

function render() {
  clearInterval(S.pollTimer);
  destroyCharts();
  if (!S.user) return renderAuth();
  if (S.user.role === 'manager') return renderManagerShell();
  return renderCustomerShell();
}

// ===================================================================== auth

function renderAuth() {
  const m = S.authMode;
  $('#app').innerHTML = `
  <div class="auth">
    <section class="auth-hero">
      <div class="brand"><span class="brand-mark">❄️</span> FreshRoute</div>
      <h1>Fresh food, routed before it spoils.</h1>
      <p>Live cold-chain sensors, AI shelf-life prediction and smart routing, so less of Qatar's imported fresh food goes to waste.</p>
      <div class="hero-flow">
        <div class="hero-step"><span class="n">1</span><div><b>Sensors stream in</b>Temperature, humidity and doors from chillers and reefer trucks</div></div>
        <div class="hero-step"><span class="n">2</span><div><b>Hybrid AI recalculates shelf life</b>A physics model plus machine learning, for every batch</div></div>
        <div class="hero-step"><span class="n">3</span><div><b>Claude grades each batch</b>Good · Mid · Low · Dispose</div></div>
        <div class="hero-step"><span class="n">4</span><div><b>Right food, right buyer</b>Standing orders, shops, flash deals or safe disposal</div></div>
      </div>
    </section>
    <section class="auth-panel">
      <div class="auth-card ${m === 'signup2' ? 'signup-wide' : ''}">
        ${m === 'login' ? loginForm() : m === 'signup1' ? signupStep1() : signupStep2()}
      </div>
    </section>
  </div>`;
  bindAuth();
}

function loginForm() {
  return `
  <div class="stack" style="gap:18px">
    <div class="tabs"><button class="active">Sign in</button><button data-go="signup1">Create account</button></div>
    <div><h2>Welcome back</h2><p class="muted">Sign in to order fresh stock or manage your warehouse.</p></div>
    <form id="loginForm" class="stack">
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>
      <div id="authErr"></div>
      <button class="btn primary block" type="submit">Sign in</button>
    </form>
    <p class="small muted" style="text-align:center">New here? <button class="link-btn" data-go="signup1">Create an account</button></p>
    <div class="stack" style="gap:8px">
      <p class="small muted">Demo accounts (click to fill in):</p>
      <div class="demo-accounts">
        <button class="demo-acc" data-demo="manager@example.com|manager123"><b>🏭 Warehouse manager</b>manager@example.com</button>
        <button class="demo-acc" data-demo="chef@example.com|demo123"><b>🍽️ Restaurant</b>chef@example.com</button>
        <button class="demo-acc" data-demo="sara@example.com|demo123"><b>🏠 Household</b>sara@example.com</button>
        <button class="demo-acc" data-demo="shop@example.com|demo123"><b>🏪 Shop / middleman</b>shop@example.com</button>
      </div>
    </div>
  </div>`;
}

function stepsBar(n, total) {
  return `<div class="steps">
    <div class="s on"><span class="n">1</span>Your details</div><div class="line"></div>
    <div class="s ${n >= 2 ? 'on' : ''}"><span class="n">2</span>${total === 1 ? 'Access' : 'What you need'}</div>
  </div>`;
}

function signupStep1() {
  const s = S.signup;
  return `
  <div class="stack" style="gap:18px">
    <div class="tabs"><button data-go="login">Sign in</button><button class="active">Create account</button></div>
    ${stepsBar(1)}
    <div><h2>Create your account</h2><p class="muted">Tell us who you are. Next you'll choose what you need most.</p></div>
    <form id="s1" class="stack">
      <div class="field" style="font-size:13px;font-weight:600;color:var(--text-2)">I am a…</div>
      <div class="type-grid">
        ${ACCOUNT_TYPES.map(t => `<button type="button" class="type-opt ${s.accountType === t.id ? 'on' : ''}" data-type="${t.id}"><span class="ic">${t.icon}</span><b>${t.name}</b><span>${t.desc}</span></button>`).join('')}
      </div>
      <div class="grid-2">
        <label class="field">Full name<input class="input" name="name" required value="${esc(s.name)}" /></label>
        <label class="field">Phone<input class="input" name="phone" placeholder="+974" value="${esc(s.phone)}" /></label>
      </div>
      <label class="field">Email<input class="input" name="email" type="email" required value="${esc(s.email)}" /></label>
      <label class="field">Password<input class="input" name="password" type="password" minlength="6" required value="${esc(s.password)}" /></label>
      <div class="grid-2">
        <label class="field ${s.accountType === 'household' ? 'hidden' : ''}">${s.accountType === 'manager' ? 'Warehouse / company' : 'Business name'}<input class="input" name="businessName" value="${esc(s.businessName)}" /></label>
        <label class="field">Area<select class="input" name="area">${AREAS.map(a => `<option ${s.area === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      </div>
      ${s.accountType === 'manager' ? `<label class="field">Warehouse access code<input class="input" name="managerCode" placeholder="Ask your administrator (demo: COLDCHAIN)" value="${esc(s.managerCode)}" /></label>` : ''}
      <div id="authErr"></div>
      <button class="btn primary block" type="submit">${s.accountType === 'manager' ? 'Create manager account' : 'Continue →'}</button>
    </form>
  </div>`;
}

function prefPicker(prefs, defaultFreq) {
  return S.meta.categories.map(c => `
    <div class="pref-cat"><h4>${c.icon} ${c.name}</h4>
      <div class="pref-grid">
        ${S.meta.products.filter(p => p.category === c.id).map(p => {
          const on = prefs[p.id];
          return `<div class="pref-item ${on ? 'on' : ''}" data-pref="${p.id}">
            <div class="top"><span class="ic">${p.icon}</span>${esc(p.name)}</div>
            ${on ? `<div class="cfg">
              <select data-freq="${p.id}">${['daily', 'weekly', 'occasionally'].map(f => `<option value="${f}" ${on.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
              <input data-pqty="${p.id}" type="number" min="1" value="${on.qty}" title="Usual quantity (${p.unit})" />
            </div>` : `<span class="small muted">Tap to add · ${defaultFreq}</span>`}
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function signupStep2() {
  const s = S.signup;
  const count = Object.keys(s.prefs).length;
  return `
  <div class="stack" style="gap:18px">
    ${stepsBar(2)}
    <div><h2>What do you need most?</h2>
      <p class="muted">Pick the products you buy regularly and how often. We'll notify you when they're in stock, when stock is running low, and when there's a flash deal on them.</p></div>
    <div class="stack" id="prefBox">${prefPicker(s.prefs, s.accountType === 'restaurant' || s.accountType === 'shop' ? 'daily' : 'weekly')}</div>
    <div id="authErr"></div>
    <div class="row"><button class="btn" data-go="signup1">← Back</button><span class="spacer"></span>
      <span class="small muted">${count} selected</span>
      <button class="btn primary" id="finishSignup">Create account</button></div>
  </div>`;
}

function bindPrefPicker(root, prefs, defaultFreq, onChange) {
  root.addEventListener('click', e => {
    if (e.target.closest('select, input')) return;
    const item = e.target.closest('[data-pref]');
    if (!item) return;
    const id = item.dataset.pref;
    if (prefs[id]) delete prefs[id];
    else prefs[id] = { frequency: defaultFreq, qty: defaultFreq === 'daily' ? 10 : 2 };
    onChange();
  });
  root.addEventListener('change', e => {
    if (e.target.dataset.freq) prefs[e.target.dataset.freq].frequency = e.target.value;
    if (e.target.dataset.pqty) prefs[e.target.dataset.pqty].qty = Number(e.target.value) || 1;
  });
}

function showAuthError(msg) { $('#authErr').innerHTML = `<div class="error">${esc(msg)}</div>`; }

function bindAuth() {
  $$('[data-go]').forEach(b => b.addEventListener('click', () => { captureStep1(); S.authMode = b.dataset.go; renderAuth(); }));
  $$('[data-demo]').forEach(b => b.addEventListener('click', () => {
    const [email, pw] = b.dataset.demo.split('|');
    $('[name=email]').value = email; $('[name=password]').value = pw;
  }));
  $('#loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { setSession(await api('/api/auth/login', { body: { email: f.get('email'), password: f.get('password') } })); }
    catch (err) { showAuthError(err.message); }
  });
  $$('[data-type]').forEach(b => b.addEventListener('click', () => { captureStep1(); S.signup.accountType = b.dataset.type; renderAuth(); }));
  $('#s1')?.addEventListener('submit', async e => {
    e.preventDefault();
    captureStep1();
    if (S.signup.accountType === 'manager') return submitSignup();
    S.authMode = 'signup2'; renderAuth();
  });
  const box = $('#prefBox');
  if (box) {
    const df = ['restaurant', 'shop'].includes(S.signup.accountType) ? 'daily' : 'weekly';
    bindPrefPicker(box, S.signup.prefs, df, renderAuth);
    $('#finishSignup').addEventListener('click', submitSignup);
  }
}

function captureStep1() {
  const form = $('#s1');
  if (!form) return;
  const f = new FormData(form);
  for (const k of ['name', 'phone', 'email', 'password', 'businessName', 'area', 'managerCode']) if (f.has(k)) S.signup[k] = f.get(k);
}

async function submitSignup() {
  const s = S.signup;
  try {
    const prefs = Object.entries(s.prefs).map(([productId, v]) => ({ productId, ...v }));
    const res = await api('/api/auth/signup', { body: { ...s, prefs } });
    S.signup = { accountType: 'restaurant', prefs: {} };
    setSession(res);
    toast('Account created', s.accountType === 'manager' ? 'Welcome to the control room.' : "We'll notify you about the products you picked.");
  } catch (err) { showAuthError(err.message); }
}

// ===================================================================== shared shell

function topbar(navItems, active) {
  const u = S.user;
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark">❄️</span> FreshRoute</div>
    <nav class="nav">${navItems.map(([id, label]) => `<button data-view="${id}" class="${active === id ? 'active' : ''}">${label}</button>`).join('')}</nav>
    <span class="spacer"></span>
    <div class="clock" id="clock"></div>
    ${u.role === 'customer' ? `<button class="icon-btn" id="bell" title="Notifications">🔔<span class="badge ${S.unread ? '' : 'hidden'}" id="bellCount">${S.unread}</span></button>` : ''}
    <div class="user-pill"><span class="avatar">${esc(u.name[0] || '?').toUpperCase()}</span>
      <div class="who"><b>${esc(u.name)}</b><div class="muted small">${esc(u.businessName || u.accountType)}</div></div></div>
    <button class="btn sm" id="logout">Sign out</button>
  </header>`;
}

function updateClock(simNow) {
  const el = $('#clock');
  if (el && simNow) el.innerHTML = `Simulated time<br><b>${fmtDay(simNow)} · ${fmtTime(simNow)}</b>`;
}

function bindTopbar(onView) {
  $$('.topbar [data-view]').forEach(b => b.addEventListener('click', () => onView(b.dataset.view)));
  $('#logout').addEventListener('click', logout);
}

// ===================================================================== customer

function renderCustomerShell() {
  S.view ||= 'shop';
  if (!S.catTab) S.catTab = S.user.prefs?.length ? 'foryou' : 'dairy';
  const nav = [['shop', '🛒 Shop'], ['deals', '🔥 Deals'], ['orders', '📦 My orders'], ['prefs', '⭐ My needs']];
  $('#app').innerHTML = `${topbar(nav, S.view)}
    <main class="page" id="main"></main>
    <div class="notif-panel card hidden" id="notifPanel"></div>`;
  bindTopbar(v => { S.view = v; renderCustomerShell(); });
  $('#bell').addEventListener('click', toggleNotifs);
  refreshCustomer(true);
  S.pollTimer = setInterval(() => refreshCustomer(false), S.meta.tickMs || 5000);
}

async function refreshCustomer(force) {
  try {
    const [cat, n] = await Promise.all([api('/api/catalog'), api('/api/notifications')]);
    const changed = JSON.stringify(cat.products) !== JSON.stringify(S.catalog?.products);
    S.catalog = cat;
    handleNotifications(n);
    updateClock(cat.simNow);
    if (S.view === 'orders' && force) S.orders = (await api('/api/orders')).orders;
    const typing = document.activeElement?.closest?.('#main') && document.activeElement.tagName === 'INPUT';
    if (force || (changed && !typing && (S.view === 'shop' || S.view === 'deals'))) renderCustomerView();
  } catch (e) { if (force) toast('Could not load', e.message, 'err'); }
}

function handleNotifications({ notifications, unread }) {
  const firstLoad = S.seenNotifs === null;
  const seen = S.seenNotifs || new Set();
  const fresh = notifications.filter(n => !seen.has(n.id));
  S.notifs = notifications; S.unread = unread; S.seenNotifs = new Set(notifications.map(n => n.id));
  const badge = $('#bellCount');
  if (badge) { badge.textContent = unread; badge.classList.toggle('hidden', !unread); }
  if (!firstLoad) {
    for (const n of fresh.slice(0, 3)) {
      toast(n.title, n.body, n.kind === 'flash' ? 'flash' : '');
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body }); } catch { /* not supported */ }
      }
    }
  }
  if (S.notifOpen) renderNotifPanel();
}

function renderNotifPanel() {
  const panel = $('#notifPanel');
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  panel.innerHTML = `
    <div class="card-head"><h3>Notifications</h3><span class="spacer"></span>
      ${canAsk ? '<button class="btn sm" id="enablePush">Enable phone/desktop alerts</button>' : ''}</div>
    ${S.notifs.length ? S.notifs.map(n => `
      <div class="notif ${n.read ? '' : 'unread'}">
        <div style="flex:1"><div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div>
        <div class="small muted">${fmtDay(n.at)} · ${fmtTime(n.at)}</div></div>
        ${n.productId ? `<button class="btn sm" data-goto="${n.productId}">View</button>` : ''}
      </div>`).join('') : '<div class="empty">No notifications yet. Add products under “My needs”.</div>'}`;
  $('#enablePush')?.addEventListener('click', async () => { await Notification.requestPermission(); renderNotifPanel(); });
  $$('[data-goto]', panel).forEach(b => b.addEventListener('click', () => {
    const p = S.productById[b.dataset.goto];
    S.view = 'shop'; S.catTab = p.category; S.notifOpen = false;
    renderCustomerShell();
  }));
}

async function toggleNotifs() {
  S.notifOpen = !S.notifOpen;
  $('#notifPanel').classList.toggle('hidden', !S.notifOpen);
  if (S.notifOpen) {
    renderNotifPanel();
    if (S.unread) { await api('/api/notifications/read', { body: {} }); S.unread = 0; $('#bellCount').classList.add('hidden'); }
  }
}

function renderCustomerView() {
  const main = $('#main');
  if (!main || !S.catalog) return;
  if (S.view === 'shop') main.innerHTML = shopView();
  else if (S.view === 'deals') main.innerHTML = dealsView();
  else if (S.view === 'orders') main.innerHTML = ordersView();
  else if (S.view === 'prefs') main.innerHTML = prefsView();
  bindCustomerView();
}

const prefOf = pid => S.user.prefs?.find(p => p.productId === pid);

function offerBlock(p, tier) {
  const o = p.offers[tier];
  if (!o) return '';
  const key = `${p.id}:${tier}`;
  const pref = prefOf(p.id);
  const q = S.qtyDraft[key] ?? Math.min(o.qty, pref?.qty ?? (tier === 'low' ? 2 : 5));
  const title = tier === 'good'
    ? `<b>Fresh</b> <span class="small muted">· up to ${o.maxShelfDays} days shelf life</span>`
    : tier === 'mid'
      ? `<b>🏷️ Wholesale lot −20%</b> <span class="small muted">· sell within ~${fmtH(o.bestWithinH)}</span>`
      : `<b>🔥 Flash deal −50%</b> <span class="small">· use within ${fmtH(o.bestWithinH)}</span>`;
  return `<div class="offer ${tier === 'low' ? 'flash' : tier === 'mid' ? 'mid' : ''}">
    <div>${title}</div>
    <div class="row"><div><span class="price">${qar(o.price)}</span><span class="small muted">/${p.unit}</span>${tier !== 'good' ? `<span class="old">${qar(p.price)}</span>` : ''}</div>
      <span class="spacer"></span><span class="small muted tnum">${o.qty} ${p.unit} left</span></div>
    <div class="row">
      <div class="qty"><button data-step="-1" data-key="${key}">−</button><input data-qty="${key}" type="number" min="1" max="${o.qty}" value="${q}" /><button data-step="1" data-key="${key}">+</button></div>
      <button class="btn primary sm" style="flex:1" data-order="${key}">Order</button>
    </div>
  </div>`;
}

function productCard(p) {
  const pref = prefOf(p.id);
  const tiers = S.catalog.tiers;
  const hasAny = tiers.some(t => p.offers[t]);
  return `<article class="card product">
    <div class="ph">${pref ? `<span class="fav chip ai">⭐ Your ${pref.frequency} item</span>` : ''}${p.icon}</div>
    <div class="pb">
      <div><h3>${esc(p.name)}</h3><span class="small muted">${S.meta.categories.find(c => c.id === p.category).name} · list price ${qar(p.price)}/${p.unit}</span></div>
      ${hasAny ? tiers.map(t => offerBlock(p, t)).join('') : `<div class="out">Out of stock right now. ${pref ? "We'll notify you when it's back." : ''}</div>`}
    </div>
  </article>`;
}

function shopView() {
  const u = S.user;
  const cats = [...(u.prefs?.length ? [{ id: 'foryou', name: 'For you', icon: '⭐' }] : []), ...S.meta.categories];
  const inCat = id => S.catalog.products.filter(p => id === 'foryou' ? prefOf(p.id) : p.category === id);
  const list = inCat(S.catTab);
  const flashCount = S.catalog.products.filter(p => p.offers.low).length;
  return `
    <div class="hello"><div><h1>Hi ${esc(u.name.split(' ')[0])} 👋</h1><p class="muted">What's available at the cold store right now. Stock and shelf life update live from our sensors.</p></div>
      <span class="spacer"></span>${flashCount ? `<button class="btn" data-view2="deals">🔥 ${flashCount} flash deals</button>` : ''}</div>
    <div class="cat-tabs">${cats.map(c => {
      const items = inCat(c.id);
      const inStock = items.filter(p => Object.keys(p.offers).length).length;
      return `<button class="cat-tab ${S.catTab === c.id ? 'active' : ''}" data-cat="${c.id}"><span class="ic">${c.icon}</span><span>${c.name}<small>${inStock}/${items.length} in stock</small></span></button>`;
    }).join('')}</div>
    <div class="products">${list.map(productCard).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`;
}

function dealsView() {
  const deals = [];
  for (const p of S.catalog.products) for (const t of ['low', 'mid']) if (p.offers[t]) deals.push({ p, t, h: p.offers[t].bestWithinH });
  deals.sort((a, b) => a.h - b.h);
  return `<div class="hello"><div><h1>🔥 Deals ending soon</h1>
    <p class="muted">Short shelf life doesn't mean unsafe. Our AI checked these batches and they're fine to eat within the time shown. Buying them keeps good food out of the bin.</p></div></div>
    ${deals.length ? `<div class="products">${deals.map(({ p }) => productCard(p)).filter((v, i, a) => a.indexOf(v) === i).join('')}</div>` : '<div class="card empty">No deals right now. We\'ll notify you when there are.</div>'}`;
}

function ordersView() {
  const o = S.orders;
  return `<div class="hello"><h1>My orders</h1></div>
    <div class="card tbl-wrap">${o.length ? `<table class="tbl"><thead><tr><th>Time</th><th>Product</th><th>Offer</th><th>Qty</th><th>Unit price</th><th>Total</th><th>Status</th></tr></thead><tbody>
    ${o.map(x => `<tr><td>${fmtDay(x.at)} ${fmtTime(x.at)}</td><td>${S.productById[x.productId]?.icon || ''} ${esc(x.productName)}</td><td>${x.tier === 'low' ? '🔥 Flash' : x.tier === 'mid' ? '🏷️ Wholesale' : 'Fresh'}</td>
      <td class="tnum">${x.qty} ${x.unit}</td><td class="tnum">${qar(x.unitPrice)}</td><td class="tnum"><b>${qar(x.total)}</b></td><td><span class="chip g-good">✓ ${x.status}</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No orders yet. Head to the shop to place your first order.</div>'}</div>`;
}

function prefsView() {
  S.prefDraft ||= Object.fromEntries((S.user.prefs || []).map(p => [p.productId, { frequency: p.frequency, qty: p.qty }]));
  return `<div class="hello"><div><h1>⭐ What I need most</h1><p class="muted">We use this to send you in-stock, low-stock and flash-deal notifications.</p></div>
    <span class="spacer"></span><button class="btn primary" id="savePrefs">Save preferences</button></div>
    <div class="card pad stack" id="prefBox">${prefPicker(S.prefDraft, ['restaurant', 'shop'].includes(S.user.accountType) ? 'daily' : 'weekly')}</div>`;
}

function bindCustomerView() {
  const main = $('#main');
  $$('[data-cat]', main).forEach(b => b.addEventListener('click', () => { S.catTab = b.dataset.cat; renderCustomerView(); }));
  $$('[data-view2]', main).forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view2; renderCustomerShell(); }));
  $$('[data-qty]', main).forEach(i => i.addEventListener('input', () => { S.qtyDraft[i.dataset.qty] = Number(i.value); }));
  $$('[data-step]', main).forEach(b => b.addEventListener('click', () => {
    const input = $(`[data-qty="${b.dataset.key}"]`, main);
    const v = Math.max(1, Math.min(Number(input.max), (Number(input.value) || 0) + Number(b.dataset.step)));
    input.value = v; S.qtyDraft[b.dataset.key] = v;
  }));
  $$('[data-order]', main).forEach(b => b.addEventListener('click', async () => {
    const [productId, tier] = b.dataset.order.split(':');
    const qty = Number($(`[data-qty="${b.dataset.order}"]`, main).value);
    b.disabled = true;
    try {
      const { order } = await api('/api/orders', { body: { productId, tier, qty } });
      delete S.qtyDraft[b.dataset.order];
      toast('Order confirmed ✓', `${order.qty} ${order.unit} ${order.productName} — ${qar(order.total)}`);
      await refreshCustomer(true);
    } catch (e) { toast('Order failed', e.message, 'err'); b.disabled = false; }
  }));
  const box = $('#prefBox');
  if (box && S.view === 'prefs') {
    bindPrefPicker(box, S.prefDraft, ['restaurant', 'shop'].includes(S.user.accountType) ? 'daily' : 'weekly', renderCustomerView);
    $('#savePrefs').addEventListener('click', async () => {
      const prefs = Object.entries(S.prefDraft).map(([productId, v]) => ({ productId, ...v }));
      S.user = (await api('/api/me/prefs', { method: 'PUT', body: { prefs } })).user;
      S.prefDraft = null;
      toast('Saved', "We'll keep you posted on these products.");
      renderCustomerView();
    });
  }
}

// ===================================================================== manager

function renderManagerShell() {
  S.view ||= 'overview';
  const nav = [['overview', '📊', 'Overview'], ['sensors', '🌡️', 'Sensors'], ['batches', '📦', 'Batches'], ['alerts', '🚨', 'Alerts'], ['ai', '🧠', 'AI pipeline']];
  $('#app').innerHTML = `${topbar([], null)}
    <div class="mgr">
      <aside class="side">
        ${nav.map(([id, ic, label]) => `<button data-mview="${id}" class="${S.view === id ? 'active' : ''}">${ic} ${label}${id === 'alerts' ? '<span class="cnt hidden" id="alertCnt"></span>' : ''}</button>`).join('')}
        <div class="side-foot">Live sensor feed · a new reading every ${S.meta.tickMs / 1000}s (${S.meta.simMinutesPerTick} simulated min)<br><br>
          <button class="link-btn" id="resetDemo">↺ Reset demo data</button></div>
      </aside>
      <main class="page" id="main" style="max-width:none;width:100%"></main>
    </div>`;
  bindTopbar(() => {});
  $$('[data-mview]').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.mview; renderManagerShell(); }));
  $('#resetDemo').addEventListener('click', async () => {
    if (!confirm('Reset all demo data (batches, alerts, orders)? Accounts are kept.')) return;
    const r = await api('/api/manager/reset', { body: {} });
    S.token = r.token; localSet('fr_token', r.token);
    toast('Demo reset', 'Fresh stock loaded and scenario restarted.');
    refreshManager(true);
  });
  refreshManager(true);
  S.pollTimer = setInterval(() => refreshManager(false), S.meta.tickMs || 5000);
}

async function refreshManager(force) {
  try {
    S.ov = await api('/api/manager/overview');
  } catch (e) { if (force) toast('Could not load dashboard', e.message, 'err'); return; }
  updateClock(S.ov.simNow);
  const cnt = $('#alertCnt');
  if (cnt) { cnt.textContent = S.ov.kpis.openAlerts; cnt.classList.toggle('hidden', !S.ov.kpis.openAlerts); }
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT';
  if (!force && typing) return;
  renderManagerView();
}

function renderManagerView() {
  const main = $('#main');
  if (!main || !S.ov) return;
  const y = window.scrollY;
  destroyCharts();
  const views = { overview: overviewView, sensors: sensorsView, batches: batchesView, alerts: alertsView, ai: aiView };
  main.innerHTML = views[S.view]();
  bindManagerView();
  drawManagerCharts();
  window.scrollTo(0, y);
}

function kpiTiles(k) {
  const tiles = [
    ['Stock on hand', `${k.stockKg.toLocaleString()} <small>kg</small>`, `${k.activeBatches} active batches`],
    ['At risk', `${k.atRiskKg.toLocaleString()} <small>kg</small>`, 'Mid + low grade, needs fast sale'],
    ['Rescued from waste', `${k.rescuedKg.toLocaleString()} <small>kg</small>`, 'Flash + wholesale + donated'],
    ['Disposed', `${k.disposedKg.toLocaleString()} <small>kg</small>`, 'Unsafe or expired'],
    ['Open alerts', `${k.openAlerts}`, `${k.criticalAlerts} critical`],
    ['Temp compliance', `${k.compliancePct}<small>%</small>`, 'Readings within ±2 °C of setpoint'],
  ];
  return `<div class="kpis">${tiles.map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v tnum">${v}</div><div class="s">${s}</div></div>`).join('')}</div>`;
}

function pipelineCard() {
  const o = S.ov;
  const last = o.aiRuns[0];
  return `<div class="card">
    <div class="card-head"><h3>Live AI pipeline</h3><span class="spacer"></span>
      <button class="btn sm primary" data-runai>🧠 Run AI grading now</button></div>
    <div class="card-body"><div class="pipeline">
      <div class="pipe-step"><span class="ic">📡</span><b>1 · Sensor feed</b><span class="m">Temperature, humidity and doors from ${o.sensors.length} chillers and trucks</span><span class="v tnum">${o.sensors.filter(s => s.online).length}/${o.sensors.length} online</span></div>
      <div class="pipe-step"><span class="ic">⚗️</span><b>2 · Kinetic model</b><span class="m">Q10 temperature law uses up shelf life on every reading</span><span class="v tnum">${o.batches.filter(b => b.status === 'active').length} batches</span></div>
      <div class="pipe-step"><span class="ic">📈</span><b>3 · ML correction</b><span class="m">Ridge regression learned from past batch outcomes</span><span class="v tnum">R² ${o.mlModel.r2}</span></div>
      <div class="pipe-step ai"><span class="ic">🧠</span><b>4 · Claude grading</b><span class="m">${o.ai.available ? esc(o.ai.model) : 'Rules fallback (no API key)'}</span><span class="v">${last ? `${fmtTime(last.at)} · ${last.source}` : 'not run yet'}</span></div>
      <div class="pipe-step"><span class="ic">🚚</span><b>5 · Routing</b><span class="m">Good → customers · Mid → shops · Low → flash sale · Dispose</span><span class="v tnum">${o.orders.length} orders</span></div>
    </div></div>
  </div>`;
}

function routesCard() {
  const k = S.ov.kpis.byGrade;
  return `<div class="card"><div class="card-head"><h3>Where the stock is going</h3><span class="small muted">kg by AI grade</span></div>
    <div class="card-body"><div class="routes">
      ${['good', 'mid', 'low', 'dispose'].map(g => `<div class="route g-${g}" style="border-color:transparent">
        ${gradeChip(g)}<span class="kg tnum">${(k[g] || 0).toLocaleString()} kg</span>
        <span class="ch">→ ${esc(S.ov.routes[g].channel)}</span><span class="d">${esc(S.ov.routes[g].description)}</span></div>`).join('')}
    </div></div></div>`;
}

function sensorState(s) {
  if (s.kind === 'truck' && s.status !== 'in-transit') return ['ok', s.status === 'returning' ? 'Returning to origin' : s.status];
  if (s.temp > s.setpoint + 6) return ['bad', 'Critical temperature'];
  if (s.temp > s.setpoint + 3) return ['bad', 'Too warm'];
  if (s.door) return ['warn', 'Door open'];
  if (s.rh < s.rhSet - 12 || s.rh > s.rhSet + 8) return ['warn', 'Humidity off'];
  return ['ok', 'Normal'];
}

function sensorCards(selectable) {
  return `<div class="sensors">${S.ov.sensors.map(s => {
    const [cls, label] = sensorState(s);
    return `<div class="card sensor ${selectable && S.selSensor === s.id ? 'sel' : ''}" data-sensor="${s.id}">
      <div class="row"><b style="font-size:14px">${s.kind === 'truck' ? '🚚' : '🏭'} ${esc(s.name)}</b></div>
      <div class="small muted">${esc(s.site)}${s.kind === 'truck' && s.status === 'in-transit' ? ` · ETA ${Math.max(0, s.etaH).toFixed(1)} h` : ''}</div>
      <div class="row"><span class="t tnum">${s.temp.toFixed(1)}°C</span><span class="spacer"></span><span class="small muted tnum">${Math.round(s.rh)}% RH</span></div>
      <div class="spark"><canvas data-spark="${s.id}"></canvas></div>
      <div class="row"><span class="state ${cls}">${label}</span><span class="spacer"></span><span class="small muted">set ${s.setpoint}°C · ${s.batchCount} batches</span></div>
    </div>`;
  }).join('')}</div>`;
}

function alertItem(a) {
  const labels = { reroute: '🚚 Reroute', adjust: '🔧 Fix / adjust', inspect: '🔍 Inspect', ack: 'Acknowledge', donate: '🤝 Donate', prioritize: '🔥 Flash sale' };
  return `<div class="alert ${a.status !== 'open' ? 'done' : ''}">
    <span class="sev ${a.severity}"></span>
    <div style="flex:1;min-width:0">
      <div class="row wrap" style="gap:8px"><span class="title">${esc(a.title)}</span>
        <span class="chip neutral">${a.severity}</span>${a.status !== 'open' ? `<span class="chip neutral">${a.status}</span>` : ''}
        <span class="spacer"></span><span class="small muted">${fmtTime(a.createdAt)}</span></div>
      <div class="msg">${esc(a.message)}</div>
      <div class="rec">💡 <b>Recommended:</b> ${esc(a.recommendation)}</div>
      ${a.note ? `<div class="small muted">✓ ${esc(a.note)}</div>` : ''}
      ${a.status === 'open' ? `<div class="row wrap" style="gap:6px;margin-top:8px">${a.actions.map(x => `<button class="btn sm ${x === 'ack' ? '' : 'primary'}" data-alert="${a.id}" data-act="${x}">${labels[x] || x}</button>`).join('')}</div>` : ''}
    </div></div>`;
}

function overviewView() {
  const o = S.ov;
  const open = o.alerts.filter(a => a.status === 'open');
  return `
    <div class="hello"><div><h1>Cold-chain control room</h1><p class="muted">${esc(S.user.businessName || 'Doha Central Cold Store')} · live</p></div></div>
    ${kpiTiles(o.kpis)}
    <div class="stack" style="gap:16px">
      ${pipelineCard()}
      ${routesCard()}
      <div class="dash-grid">
        <div class="card"><div class="card-head"><h3>Most urgent batches</h3><span class="small muted">predicted hours of shelf life left</span><span class="spacer"></span><button class="btn sm" data-goview="batches">All batches →</button></div>
          <div class="card-body"><div class="chart-box tall"><canvas id="urgentChart"></canvas></div>
          <div class="legend" style="margin-top:8px">${['good', 'mid', 'low'].map(g => `<span><i style="background:${gradeColor(g)};height:10px;width:10px;border-radius:2px"></i>${GRADE[g].label}</span>`).join('')}</div></div></div>
        <div class="card"><div class="card-head"><h3>Open alerts</h3><span class="chip neutral">${open.length}</span><span class="spacer"></span><button class="btn sm" data-goview="alerts">All →</button></div>
          <div style="max-height:380px;overflow:auto">${open.slice(0, 5).map(alertItem).join('') || '<div class="empty">✓ All clear</div>'}</div></div>
      </div>
      <div><div class="section-title"><h2>Sensors</h2><span class="muted small">click a sensor for its full history</span></div>${sensorCards(false)}</div>
      <div class="card"><div class="card-head"><h3>Activity</h3></div><div class="feed" style="max-height:300px;overflow:auto">
        ${o.events.map(e => `<div class="ev"><span class="tm">${fmtTime(e.at)}</span><span>${esc(e.message)}</span></div>`).join('')}</div></div>
    </div>`;
}

function sensorsView() {
  const s = S.ov.sensors.find(x => x.id === S.selSensor) || S.ov.sensors[0];
  const stored = S.ov.batches.filter(b => b.locationId === s.id && b.status === 'active');
  return `
    <div class="hello"><div><h1>Sensors</h1><p class="muted">Every chiller and reefer truck streams readings into the pipeline. Pick one to inspect it.</p></div></div>
    ${sensorCards(true)}
    <div class="dash-grid" style="margin-top:16px">
      <div class="stack" style="gap:16px">
        <div class="card"><div class="card-head"><h3>🌡️ Temperature — ${esc(s.name)}</h3></div>
          <div class="card-body"><div class="legend" style="margin-bottom:8px">
            <span><i style="background:${cssVar('--accent')}"></i>Temperature</span>
            <span><i style="background:${cssVar('--muted')}"></i>Setpoint</span>
            <span><i style="background:${cssVar('--critical')}"></i>Alert threshold (+3 °C)</span></div>
            <div class="chart-box"><canvas id="tempChart"></canvas></div></div></div>
        <div class="card"><div class="card-head"><h3>💧 Relative humidity</h3><span class="small muted">target ${s.rhSet}%</span></div>
          <div class="card-body"><div class="chart-box short"><canvas id="rhChart"></canvas></div></div></div>
      </div>
      <div class="stack" style="gap:16px">
        <div class="card"><div class="card-head"><h3>Simulate an incident</h3></div>
          <div class="card-body stack"><p class="small muted">Demo controls: inject a fault and watch alerts, shelf-life predictions and grades react live.</p>
            <div class="row wrap" style="gap:8px">
              <button class="btn sm" data-fault="compressor">❄️✕ Compressor failure</button>
              <button class="btn sm" data-fault="door">🚪 Door left open</button>
              <button class="btn sm" data-fault="humidifier">💧 Humidifier failure</button>
              <button class="btn sm" data-fault="">✓ Clear fault</button>
            </div>
            <div class="small">Current fault: <b>${s.fault || 'none'}</b></div>
            <div class="small muted">Real sensors can push readings to <code>POST /api/ingest</code> (see README).</div>
          </div></div>
        <div class="card"><div class="card-head"><h3>Stored here</h3><span class="chip neutral">${stored.length}</span></div>
          <div class="tbl-wrap"><table class="tbl"><tbody>${stored.map(b => `<tr><td>${b.product.icon} ${esc(b.product.name)}<div class="small muted">${b.id}</div></td><td class="tnum">${b.qty} ${b.product.unit}</td><td class="tnum">${fmtH(b.pred.remainingH)}</td><td>${gradeChip(b.grade)}</td></tr>`).join('') || '<tr><td class="muted">Empty</td></tr>'}</tbody></table></div></div>
      </div>
    </div>`;
}

function lifeBar(b) {
  const pct = Math.max(2, Math.min(100, b.pred.fraction * 100));
  return `<div class="life"><div class="bar"><i style="width:${pct}%;background:${gradeColor(b.grade)}"></i></div><span class="tnum small" style="width:74px">${fmtH(b.pred.remainingH)}<span class="muted"> ±${fmtH(b.pred.uncertaintyH)}</span></span></div>`;
}

function batchesView() {
  const f = S.filters;
  let list = S.ov.batches.slice();
  if (f.grade !== 'all') list = list.filter(b => b.grade === f.grade);
  if (f.category !== 'all') list = list.filter(b => b.product.category === f.category);
  if (f.q) list = list.filter(b => `${b.id} ${b.product.name} ${b.location} ${b.origin}`.toLowerCase().includes(f.q.toLowerCase()));
  list.sort((a, b) => (a.status === 'disposed') - (b.status === 'disposed') || a.pred.remainingH - b.pred.remainingH);
  const actionBtns = b => b.status !== 'active' ? '<span class="small muted">disposed</span>' : `
    <div class="row" style="gap:4px">
      <button class="btn sm" title="Log inspection" data-bact="inspect" data-batch="${b.id}">🔍</button>
      ${b.grade !== 'low' ? `<button class="btn sm" title="Move to flash sale" data-bact="prioritize" data-batch="${b.id}">🔥</button>` : ''}
      ${!b.pred.safetyBreach ? `<button class="btn sm" title="Donate to food-rescue partner" data-bact="donate" data-batch="${b.id}">🤝</button>` : ''}
      <button class="btn sm danger" title="Dispose" data-bact="dispose" data-batch="${b.id}">🗑️</button></div>`;
  return `
    <div class="hello"><div><h1>Batches</h1><p class="muted">Every batch's recalculated shelf life, spoilage risk and AI grade. Most urgent first. Click a row for the model breakdown.</p></div></div>
    <div class="filters">
      <select class="input" data-filter="grade"><option value="all">All grades</option>${Object.keys(GRADE).map(g => `<option value="${g}" ${f.grade === g ? 'selected' : ''}>${GRADE[g].label}</option>`).join('')}</select>
      <select class="input" data-filter="category"><option value="all">All categories</option>${S.meta.categories.map(c => `<option value="${c.id}" ${f.category === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <input class="input" data-filter="q" placeholder="Search batch, product, location…" value="${esc(f.q)}" />
      <span class="small muted">${list.length} batches</span>
    </div>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Batch</th><th>Location</th><th>Qty</th><th>Shelf life left</th><th>Risk</th><th>AI grade</th><th>Reason & recommended action</th><th></th></tr></thead>
      <tbody>${list.map(b => `
        <tr data-row="${b.id}" style="cursor:pointer">
          <td><b>${b.product.icon} ${esc(b.product.name)}</b><div class="small muted">${b.id} · ${esc(b.origin)}</div></td>
          <td class="small">${b.locationKind === 'truck' ? '🚚' : '🏭'} ${esc(b.location)}</td>
          <td class="tnum">${b.status === 'active' ? b.qty : b.disposedQty} ${b.product.unit}</td>
          <td>${lifeBar(b)}</td>
          <td class="tnum"><b>${b.pred.risk}</b><span class="muted small">/100</span></td>
          <td>${gradeChip(b.grade)}<div class="small muted">${b.gradeSource === 'claude' ? '🧠 Claude' : esc(b.gradeSource)}</div></td>
          <td class="small" style="max-width:340px">${esc(b.reason)}<div><b>→ ${esc(b.action)}</b></div></td>
          <td>${actionBtns(b)}</td>
        </tr>
        ${S.expanded.has(b.id) ? `<tr class="detail"><td colspan="8">${batchDetail(b)}</td></tr>` : ''}`).join('')}
      </tbody></table></div>`;
}

function batchDetail(b) {
  const p = b.pred, e = b.exposure;
  const cells = [
    ['Age', `${p.ageH} h`], ['Base shelf life @ ideal', `${b.product.baseShelfH} h @ ${b.product.idealTemp} °C`],
    ['① Kinetic model: left', `${p.kineticRemainingH} h`], ['② ML correction factor', `× ${p.mlRatio}`],
    ['Corrected (ideal storage)', `${p.remainingIdealH} h`], ['Current decay rate', `${p.currentRate}× ideal`],
    ['③ Prediction at current conditions', `${p.remainingH} h ± ${p.uncertaintyH}`], ['Rule baseline grade', GRADE[p.ruleGrade].label],
    ['Hours above safe temp', `${e.abuseH.toFixed(1)} h (> ${b.product.maxSafeTemp} °C)`], ['Excess heat', `${e.excessDegH.toFixed(0)} °C·h`],
    ['Max temperature seen', `${e.maxTemp.toFixed(1)} °C`], ['Transit / handling', `${e.transitH.toFixed(0)} h · ${e.handlingEvents} events`],
  ];
  return `<div class="break">${cells.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">Route: <b>${esc(S.ov.routes[b.grade].channel)}</b></p>`;
}

function alertsView() {
  const f = S.alertFilter;
  const list = S.ov.alerts.filter(a => f === 'all' || (f === 'open' ? a.status === 'open' : a.status !== 'open'));
  return `
    <div class="hello"><div><h1>Alerts</h1><p class="muted">Cold-chain issues found automatically, each with a recommended action you can take in one click.</p></div></div>
    <div class="tabs" style="max-width:420px;margin-bottom:14px">
      ${[['open', 'Open'], ['done', 'Handled'], ['all', 'All']].map(([k, l]) => `<button data-afilter="${k}" class="${f === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="card">${list.map(alertItem).join('') || '<div class="empty">✓ Nothing here</div>'}</div>`;
}

function aiView() {
  const o = S.ov;
  return `
    <div class="hello"><div><h1>AI pipeline</h1><p class="muted">How FreshRoute turns raw sensor numbers into decisions.</p></div></div>
    <div class="stack" style="gap:16px">
      ${pipelineCard()}
      <div class="dash-grid">
        <div class="card"><div class="card-head"><h3>① + ② Hybrid shelf-life model</h3></div>
          <div class="card-body stack explain">
            <p><b>Kinetic (physics) part.</b> Each product has a base shelf life at its ideal temperature. Every sensor reading uses up life at <code>rate = Q10^((T − T_ideal)/10)</code>, with extra penalties for humidity outside the product's range and chill injury for tropical produce.</p>
            <p><b>Machine-learning part.</b> A ridge regression trained on ${o.mlModel.trainSize} historical batch outcomes learns how real shelf life differs from the physics estimate, using temperature abuse, humidity stress, handling and transit time. Held-out test: <b>R² ${o.mlModel.r2}</b>, RMSE ${o.mlModel.rmse} (fraction of shelf life).</p>
            <div class="chart-box short"><canvas id="weightsChart"></canvas></div>
            <p class="small muted">Learned effect of each feature on the shelf-life correction factor. Negative means shorter real life.</p>
          </div></div>
        <div class="card"><div class="card-head"><h3>③ LLM grading — ${o.ai.available ? '🧠 Claude connected' : '⚙️ rules fallback'}</h3></div>
          <div class="card-body stack explain">
            <p>The recalculated shelf life, risk score and history of every batch are sent to <b>${esc(o.ai.model)}</b>, which returns a grade, a short reason and a practical action for each one. A food-safety guardrail means the LLM can never keep a batch on sale that the hard rules say must be disposed.</p>
            ${o.ai.available ? '' : '<div class="error">No ANTHROPIC_API_KEY set, so rule-based grading is active. Add a key and restart to switch on Claude (see README).</div>'}
            <button class="btn primary" data-runai>🧠 Run AI grading now</button>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Trigger</th><th>Engine</th><th>Batches</th><th>Changed</th><th>Took</th></tr></thead><tbody>
              ${o.aiRuns.map(r => `<tr><td>${fmtTime(r.at)}</td><td>${r.trigger}</td><td>${r.source === 'claude' ? `🧠 ${esc(r.model || 'claude')}` : `⚙️ rules${r.error ? `<div class="small muted">${esc(r.error)}</div>` : ''}`}</td><td class="tnum">${r.batches}</td><td class="tnum">${r.changed}</td><td class="tnum">${(r.ms / 1000).toFixed(1)}s</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No runs yet</td></tr>'}
            </tbody></table></div>
          </div></div>
      </div>
      ${routesCard()}
    </div>`;
}

function bindManagerView() {
  const main = $('#main');
  $$('[data-goview]', main).forEach(b => b.addEventListener('click', () => { S.view = b.dataset.goview; renderManagerShell(); }));
  $$('[data-sensor]', main).forEach(c => c.addEventListener('click', () => { S.selSensor = c.dataset.sensor; S.view = 'sensors'; renderManagerShell(); }));
  $$('[data-alert]', main).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api(`/api/manager/alerts/${b.dataset.alert}/action`, { body: { action: b.dataset.act } }); toast('Done', r.message); }
    catch (e) { toast('Action failed', e.message, 'err'); }
    refreshManager(true);
  }));
  $$('[data-bact]', main).forEach(b => b.addEventListener('click', async ev => {
    ev.stopPropagation();
    if (b.dataset.bact === 'dispose' && !confirm('Dispose this batch? It will be removed from sale.')) return;
    try { const r = await api(`/api/manager/batches/${b.dataset.batch}/action`, { body: { action: b.dataset.bact } }); toast('Done', r.message); }
    catch (e) { toast('Action failed', e.message, 'err'); }
    refreshManager(true);
  }));
  $$('[data-row]', main).forEach(r => r.addEventListener('click', () => {
    const id = r.dataset.row;
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    renderManagerView();
  }));
  $$('[data-filter]', main).forEach(i => i.addEventListener(i.tagName === 'INPUT' ? 'input' : 'change', () => {
    S.filters[i.dataset.filter] = i.value;
    if (i.tagName === 'INPUT') { clearTimeout(S._ft); S._ft = setTimeout(() => { renderManagerView(); const el = $('[data-filter=q]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); }
    else renderManagerView();
  }));
  $$('[data-afilter]', main).forEach(b => b.addEventListener('click', () => { S.alertFilter = b.dataset.afilter; renderManagerView(); }));
  $$('[data-fault]', main).forEach(b => b.addEventListener('click', async () => {
    await api(`/api/manager/sensors/${S.selSensor}/fault`, { body: { fault: b.dataset.fault || null } });
    toast(b.dataset.fault ? 'Fault injected' : 'Fault cleared', 'Watch the next readings.');
    refreshManager(true);
  }));
  $$('[data-runai]', main).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '🧠 Grading…';
    try {
      const { run } = await api('/api/manager/ai/run', { body: {} });
      if (run.skipped) toast('Already running', 'A grading run is in progress.');
      else toast(run.source === 'claude' ? 'Claude graded all batches' : 'Rule-based grading applied', `${run.batches} batches · ${run.changed} changed${run.error ? ` · ${run.error}` : ''}`);
    } catch (e) { toast('AI run failed', e.message, 'err'); }
    refreshManager(true);
  }));
}

// ===================================================================== charts

function destroyCharts() {
  for (const c of Object.values(S.charts)) c.destroy();
  S.charts = {};
}

function baseOptions() {
  const muted = cssVar('--muted'), grid = cssVar('--grid');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: cssVar('--text'), titleColor: cssVar('--surface'), bodyColor: cssVar('--surface'), padding: 10, cornerRadius: 8 } },
    scales: {
      x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 8, font: { size: 11 } }, border: { color: grid } },
      y: { grid: { color: grid }, ticks: { color: muted, font: { size: 11 } }, border: { display: false } },
    },
  };
}

function drawManagerCharts() {
  if (typeof Chart === 'undefined') return;
  const o = S.ov;
  // sparklines
  for (const cv of $$('[data-spark]')) {
    const s = o.sensors.find(x => x.id === cv.dataset.spark);
    const h = s.history.slice(-48);
    const [cls] = sensorState(s);
    S.charts[`sp-${s.id}`] = new Chart(cv, {
      type: 'line',
      data: { labels: h.map(r => fmtTime(r.t)), datasets: [{ data: h.map(r => r.temp), borderColor: cls === 'bad' ? cssVar('--critical') : cssVar('--accent'), borderWidth: 2, pointRadius: 0, tension: .3 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, suggestedMin: s.setpoint - 2, suggestedMax: s.setpoint + 4 } } },
    });
  }
  // urgent batches
  const urgent = $('#urgentChart');
  if (urgent) {
    const list = o.batches.filter(b => b.status === 'active').sort((a, b) => a.pred.remainingH - b.pred.remainingH).slice(0, 10);
    const opts = baseOptions();
    opts.indexAxis = 'y';
    opts.interaction = { mode: 'nearest', axis: 'y', intersect: false };
    opts.scales.x = { grid: { color: cssVar('--grid') }, ticks: { color: cssVar('--muted') }, title: { display: true, text: 'hours left at current conditions', color: cssVar('--muted') }, border: { display: false } };
    opts.scales.y = { grid: { display: false }, ticks: { color: cssVar('--text-2'), font: { size: 12 } }, border: { color: cssVar('--grid') } };
    opts.plugins.tooltip.callbacks = { label: ctx => { const b = list[ctx.dataIndex]; return ` ${b.pred.remainingH} h left · ${b.qty} ${b.product.unit} · ${GRADE[b.grade].label}`; } };
    S.charts.urgent = new Chart(urgent, {
      type: 'bar',
      data: { labels: list.map(b => `${b.product.icon} ${b.product.name} (${b.id})`), datasets: [{ data: list.map(b => b.pred.remainingH), backgroundColor: list.map(b => gradeColor(b.grade)), borderRadius: 4, borderSkipped: 'start', barThickness: 16 }] },
      options: opts,
    });
  }
  // sensor detail
  const tc = $('#tempChart');
  if (tc) {
    const s = o.sensors.find(x => x.id === S.selSensor) || o.sensors[0];
    const labels = s.history.map(r => fmtTime(r.t));
    const opts = baseOptions();
    opts.scales.y.title = { display: true, text: '°C', color: cssVar('--muted') };
    opts.plugins.tooltip.callbacks = { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} °C` };
    S.charts.temp = new Chart(tc, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Temperature', data: s.history.map(r => r.temp), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .25 },
        { label: 'Setpoint', data: labels.map(() => s.setpoint), borderColor: cssVar('--muted'), borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0 },
        { label: 'Alert threshold', data: labels.map(() => s.setpoint + 3), borderColor: cssVar('--critical'), borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
      ] },
      options: opts,
    });
    const ro = baseOptions();
    ro.scales.y.title = { display: true, text: '% RH', color: cssVar('--muted') };
    ro.plugins.tooltip.callbacks = { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}%` };
    S.charts.rh = new Chart($('#rhChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Humidity', data: s.history.map(r => r.rh), borderColor: cssVar('--accent'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .25 },
        { label: 'Target', data: labels.map(() => s.rhSet), borderColor: cssVar('--muted'), borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0 },
      ] },
      options: ro,
    });
  }
  const wc = $('#weightsChart');
  if (wc) {
    const names = o.mlModel.featureNames.slice(1), w = o.mlModel.weights.slice(1);
    const opts = baseOptions();
    opts.indexAxis = 'y';
    opts.interaction = { mode: 'nearest', axis: 'y', intersect: false };
    opts.scales.x = { grid: { color: cssVar('--grid') }, ticks: { color: cssVar('--muted') }, border: { display: false } };
    opts.scales.y = { grid: { display: false }, ticks: { color: cssVar('--text-2') } };
    opts.plugins.tooltip.callbacks = { label: ctx => ` weight ${ctx.parsed.x}` };
    S.charts.w = new Chart(wc, { type: 'bar', data: { labels: names, datasets: [{ data: w, backgroundColor: cssVar('--accent'), borderRadius: 4, barThickness: 14 }] }, options: opts });
  }
}

boot();
