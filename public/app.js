// FreshRoute frontend — a dependency-free single-page app (Chart.js for sparklines).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWhen = t => `${new Date(t).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(t)}`;
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
  { id: 'restaurant', icon: '🍽️', name: 'Restaurant / café', desc: 'Fresh + flash deals' },
  { id: 'hotel', icon: '🏨', name: 'Hotel / caterer', desc: 'Fresh + flash deals' },
  { id: 'supermarket', icon: '🛒', name: 'Supermarket', desc: 'Fresh stock only' },
  { id: 'shop', icon: '🏪', name: 'Small shop / middleman', desc: 'Fresh + wholesale lots' },
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
  ov: null, simSensor: 'S-06', expanded: new Set(), filters: { grade: 'all', category: 'all', q: '' },
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
  S.view = null; S.seenNotifs = null; S.catTab = null;
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
      <p>A cold store's B2B platform: live sensors, AI shelf-life prediction and smart routing, so less of Qatar's imported fresh food goes to waste.</p>
      <div class="hero-flow">
        <div class="hero-step"><span class="n">1</span><div><b>Sensors stream in</b>Temperature, humidity and doors from chillers and reefer trucks</div></div>
        <div class="hero-step"><span class="n">2</span><div><b>Hybrid AI recalculates shelf life</b>A physics model plus machine learning, for every batch</div></div>
        <div class="hero-step"><span class="n">3</span><div><b>Claude grades each batch</b>Good · Mid · Low · Dispose</div></div>
        <div class="hero-step"><span class="n">4</span><div><b>Right food, right business</b>Regular buyers, shops, same-day flash deals or safe disposal</div></div>
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
    <div><h2>Welcome back</h2><p class="muted">Sign in to order stock for your business or manage the warehouse.</p></div>
    <form id="loginForm" class="stack">
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>
      <div id="authErr"></div>
      <button class="btn primary block" type="submit">Sign in</button>
    </form>
    <p class="small muted" style="text-align:center">New business? <button class="link-btn" data-go="signup1">Create an account</button></p>
    <div class="stack" style="gap:8px">
      <p class="small muted">Demo accounts (click to fill in):</p>
      <div class="demo-accounts">
        <button class="demo-acc" data-demo="manager@example.com|manager123"><b>🏭 Warehouse manager</b>manager@example.com</button>
        <button class="demo-acc" data-demo="chef@example.com|demo123"><b>🍽️ Restaurant</b>chef@example.com</button>
        <button class="demo-acc" data-demo="hotel@example.com|demo123"><b>🏨 Hotel kitchen</b>hotel@example.com</button>
        <button class="demo-acc" data-demo="shop@example.com|demo123"><b>🏪 Shop / middleman</b>shop@example.com</button>
      </div>
    </div>
  </div>`;
}

function stepsBar(n) {
  return `<div class="steps">
    <div class="s on"><span class="n">1</span>Business details</div><div class="line"></div>
    <div class="s ${n >= 2 ? 'on' : ''}"><span class="n">2</span>What you need</div>
  </div>`;
}

function signupStep1() {
  const s = S.signup;
  const mgr = s.accountType === 'manager';
  return `
  <div class="stack" style="gap:18px">
    <div class="tabs"><button data-go="login">Sign in</button><button class="active">Create account</button></div>
    ${stepsBar(1)}
    <div><h2>Create your business account</h2><p class="muted">FreshRoute sells in bulk to businesses. Next you'll choose what you need most.</p></div>
    <form id="s1" class="stack">
      <div class="field" style="font-size:13px;font-weight:600;color:var(--text-2)">Business type</div>
      <div class="type-grid">
        ${ACCOUNT_TYPES.map(t => `<button type="button" class="type-opt ${s.accountType === t.id ? 'on' : ''}" data-type="${t.id}"><span class="ic">${t.icon}</span><b>${t.name}</b><span>${t.desc}</span></button>`).join('')}
      </div>
      <label class="field">${mgr ? 'Warehouse / company' : 'Business name'}<input class="input" name="businessName" required value="${esc(s.businessName)}" /></label>
      <div class="grid-2">
        <label class="field">Contact name<input class="input" name="name" required value="${esc(s.name)}" /></label>
        <label class="field">Phone<input class="input" name="phone" placeholder="+974" value="${esc(s.phone)}" /></label>
      </div>
      <label class="field">Email<input class="input" name="email" type="email" required value="${esc(s.email)}" /></label>
      <div class="grid-2">
        <label class="field">Password<input class="input" name="password" type="password" minlength="6" required value="${esc(s.password)}" /></label>
        <label class="field">Delivery area<select class="input" name="area">${AREAS.map(a => `<option ${s.area === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      </div>
      ${mgr ? `<label class="field">Warehouse access code<input class="input" name="managerCode" placeholder="Ask your administrator (demo: COLDCHAIN)" value="${esc(s.managerCode)}" /></label>` : ''}
      <div id="authErr"></div>
      <button class="btn primary block" type="submit">${mgr ? 'Create manager account' : 'Continue →'}</button>
    </form>
  </div>`;
}

function prefPicker(prefs) {
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
            </div>` : '<span class="small muted">Tap to add</span>'}
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function signupStep2() {
  const count = Object.keys(S.signup.prefs).length;
  return `
  <div class="stack" style="gap:18px">
    ${stepsBar(2)}
    <div><h2>What does your business need most?</h2>
      <p class="muted">Pick the products you buy regularly, how often, and your usual quantity. We'll notify you when they're in stock, when stock is running low, and when there's a deal on them.</p></div>
    <div class="stack" id="prefBox">${prefPicker(S.signup.prefs)}</div>
    <div id="authErr"></div>
    <div class="row"><button class="btn" data-go="signup1">← Back</button><span class="spacer"></span>
      <span class="small muted">${count} selected</span>
      <button class="btn primary" id="finishSignup">Create account</button></div>
  </div>`;
}

function bindPrefPicker(root, prefs, onChange) {
  root.addEventListener('click', e => {
    if (e.target.closest('select, input')) return;
    const item = e.target.closest('[data-pref]');
    if (!item) return;
    const id = item.dataset.pref;
    if (prefs[id]) delete prefs[id];
    else prefs[id] = { frequency: 'daily', qty: 20 };
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
    bindPrefPicker(box, S.signup.prefs, renderAuth);
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
    <div class="user-pill"><span class="avatar">${esc((u.businessName || u.name)[0] || '?').toUpperCase()}</span>
      <div class="who"><b>${esc(u.businessName || u.name)}</b><div class="muted small">${esc(u.name)}</div></div></div>
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
  if (!S.catTab) S.catTab = S.user.prefs?.length ? 'foryou' : 'meat';
  $('#app').innerHTML = `${topbar([['shop', '🛒 Shop'], ['orders', '📦 My orders']], S.view)}
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
    let changed = JSON.stringify(cat.products) !== JSON.stringify(S.catalog?.products);
    S.catalog = cat;
    handleNotifications(n);
    updateClock(cat.simNow);
    if (S.view === 'orders') {
      const { orders } = await api('/api/orders');
      changed = JSON.stringify(orders) !== JSON.stringify(S.orders);
      S.orders = orders;
    }
    const typing = document.activeElement?.closest?.('#main') && document.activeElement.tagName === 'INPUT';
    if (force || (changed && !typing)) renderCustomerView();
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
      </div>`).join('') : '<div class="empty">No notifications yet. They appear for the products you picked at sign-up.</div>'}`;
  $('#enablePush')?.addEventListener('click', async () => { await Notification.requestPermission(); renderNotifPanel(); });
  $$('[data-goto]', panel).forEach(b => b.addEventListener('click', () => {
    S.view = 'shop'; S.catTab = S.productById[b.dataset.goto].category; S.notifOpen = false;
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
  main.innerHTML = S.view === 'orders' ? ordersView() : shopView();
  bindCustomerView();
}

const prefOf = pid => S.user.prefs?.find(p => p.productId === pid);

function deliveryLine(d) {
  return d.type === 'express'
    ? `⚡ Same-day express · arrives by ${fmtTime(d.etaAt)}`
    : `🚚 Scheduled route · arrives ${fmtWhen(d.etaAt)}`;
}

function offerBlock(p, tier) {
  const o = p.offers[tier];
  if (!o) return '';
  const key = `${p.id}:${tier}`;
  const pref = prefOf(p.id);
  const q = S.qtyDraft[key] ?? Math.max(o.minQty, Math.min(o.qty, pref?.qty ?? 10));
  const title = tier === 'good'
    ? `<b>Fresh</b> <span class="small muted">· up to ${o.maxShelfDays} days shelf life</span>`
    : tier === 'mid'
      ? `<b>🏷️ Wholesale lot −20%</b> <span class="small muted">· sell within ~${fmtH(o.bestWithinH)}</span>`
      : `<b>🔥 Flash deal −50%</b> <span class="small">· use within ${fmtH(o.bestWithinH)}</span>`;
  return `<div class="offer ${tier === 'low' ? 'flash' : tier === 'mid' ? 'mid' : ''}">
    <div>${title}</div>
    <div class="row"><div><span class="price">${qar(o.price)}</span><span class="small muted">/${p.unit}</span>${tier !== 'good' ? `<span class="old">${qar(p.price)}</span>` : ''}</div>
      <span class="spacer"></span><span class="small muted tnum">${o.qty} ${p.unit} left</span></div>
    <div class="small muted">${deliveryLine(o.delivery)}</div>
    <div class="row">
      <div class="qty"><button data-step="-1" data-key="${key}">−</button><input data-qty="${key}" type="number" min="${o.minQty}" max="${o.qty}" value="${q}" /><button data-step="1" data-key="${key}">+</button></div>
      <button class="btn primary sm" style="flex:1" data-order="${key}">Order</button>
    </div>
  </div>`;
}

function productCard(p) {
  const pref = prefOf(p.id);
  const tiers = S.catalog.tiers;
  const hasAny = tiers.some(t => p.offers[t]);
  return `<article class="card product" id="p-${p.id}">
    <div class="ph">${pref ? `<span class="fav chip ai">⭐ You buy ${pref.frequency}</span>` : ''}${p.icon}</div>
    <div class="pb">
      <div><h3>${esc(p.name)}</h3><span class="small muted">Min. order ${Math.min(5, p.offers.good?.qty ?? 5)} ${p.unit}</span></div>
      ${hasAny ? tiers.map(t => offerBlock(p, t)).join('') : `<div class="out">Out of stock right now.${pref ? " We'll notify you when it's back." : ''}</div>`}
    </div>
  </article>`;
}

function dealsBanner() {
  const dealTier = S.catalog.tiers.includes('low') ? 'low' : S.catalog.tiers.includes('mid') ? 'mid' : null;
  if (!dealTier) return '';
  const deals = S.catalog.products.filter(p => p.offers[dealTier]).sort((a, b) => a.offers[dealTier].bestWithinH - b.offers[dealTier].bestWithinH);
  if (!deals.length) return '';
  const flash = dealTier === 'low';
  return `<div class="card deals ${flash ? 'flash' : 'mid'}">
    <div class="card-head"><h3>${flash ? '🔥 Flash deals — use today, same-day delivery' : '🏷️ Wholesale lots — 20% off, resell within days'}</h3>
      <span class="small muted">${flash ? 'AI-checked: safe, but shelf life is short' : 'Mid-grade stock picked for resellers'}</span></div>
    <div class="deal-list">${deals.map(p => {
      const o = p.offers[dealTier];
      return `<button class="deal" data-jump="${p.id}"><span class="ic">${p.icon}</span>
        <span class="dn"><b>${esc(p.name)}</b><span class="small">${o.qty} ${p.unit} · use within ${fmtH(o.bestWithinH)}</span></span>
        <span class="dp"><b>${qar(o.price)}</b><span class="old">${qar(p.price)}</span></span></button>`;
    }).join('')}</div>
  </div>`;
}

function shopView() {
  const u = S.user;
  const cats = [...(u.prefs?.length ? [{ id: 'foryou', name: 'For you', icon: '⭐' }] : []), ...S.meta.categories];
  const inCat = id => S.catalog.products.filter(p => id === 'foryou' ? prefOf(p.id) : p.category === id);
  const list = inCat(S.catTab);
  return `
    <div class="hello"><div><h1>Hi ${esc(u.name.split(' ')[0])} 👋</h1><p class="muted">Live stock at the cold store for <b>${esc(u.businessName)}</b>. Shelf life is recalculated from our sensors every few minutes.</p></div></div>
    ${dealsBanner()}
    <div class="cat-tabs">${cats.map(c => {
      const items = inCat(c.id);
      const inStock = items.filter(p => Object.keys(p.offers).length).length;
      return `<button class="cat-tab ${S.catTab === c.id ? 'active' : ''}" data-cat="${c.id}"><span class="ic">${c.icon}</span><span>${c.name}<small>${inStock}/${items.length} in stock</small></span></button>`;
    }).join('')}</div>
    <div class="products">${list.map(productCard).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`;
}

const STATUS = {
  confirmed: ['neutral', '🕒 Confirmed'],
  'out-for-delivery': ['g-mid', '🚚 Out for delivery'],
  delivered: ['g-good', '✓ Delivered'],
};

function ordersView() {
  const o = S.orders;
  return `<div class="hello"><div><h1>My orders</h1><p class="muted">Fresh and wholesale orders go on the next scheduled reefer route. Flash deals go out the same day by express van.</p></div></div>
    <div class="card tbl-wrap">${o.length ? `<table class="tbl"><thead><tr><th>Ordered</th><th>Product</th><th>Qty</th><th>Total</th><th>Delivery</th><th>Status</th></tr></thead><tbody>
    ${o.map(x => {
      const [cls, label] = STATUS[x.status] || STATUS.confirmed;
      return `<tr><td>${fmtWhen(x.at)}</td>
        <td>${S.productById[x.productId]?.icon || ''} ${esc(x.productName)}<div class="small muted">${x.tier === 'low' ? '🔥 Flash deal' : x.tier === 'mid' ? '🏷️ Wholesale lot' : 'Fresh'} · ${qar(x.unitPrice)}/${x.unit}</div></td>
        <td class="tnum">${x.qty} ${x.unit}</td><td class="tnum"><b>${qar(x.total)}</b></td>
        <td class="small">${x.delivery ? `${x.delivery.type === 'express' ? '⚡' : '🚚'} ${esc(x.delivery.label)}<div class="muted">arrives ${fmtWhen(x.delivery.etaAt)}</div>` : ''}</td>
        <td><span class="chip ${cls}">${label}</span></td></tr>`;
    }).join('')}
    </tbody></table>` : '<div class="empty">No orders yet. Head to the shop to place your first order.</div>'}</div>`;
}

function bindCustomerView() {
  const main = $('#main');
  $$('[data-cat]', main).forEach(b => b.addEventListener('click', () => { S.catTab = b.dataset.cat; renderCustomerView(); }));
  $$('[data-jump]', main).forEach(b => b.addEventListener('click', () => {
    S.catTab = S.productById[b.dataset.jump].category;
    renderCustomerView();
    $(`#p-${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $$('[data-qty]', main).forEach(i => i.addEventListener('input', () => { S.qtyDraft[i.dataset.qty] = Number(i.value); }));
  $$('[data-step]', main).forEach(b => b.addEventListener('click', () => {
    const input = $(`[data-qty="${b.dataset.key}"]`, main);
    const v = Math.max(Number(input.min), Math.min(Number(input.max), (Number(input.value) || 0) + Number(b.dataset.step)));
    input.value = v; S.qtyDraft[b.dataset.key] = v;
  }));
  $$('[data-order]', main).forEach(b => b.addEventListener('click', async () => {
    const [productId, tier] = b.dataset.order.split(':');
    const qty = Number($(`[data-qty="${b.dataset.order}"]`, main).value);
    b.disabled = true;
    try {
      const { order } = await api('/api/orders', { body: { productId, tier, qty } });
      delete S.qtyDraft[b.dataset.order];
      toast('Order confirmed ✓', `${order.qty} ${order.unit} ${order.productName} · ${qar(order.total)} · arrives ${fmtWhen(order.delivery.etaAt)}`);
      await refreshCustomer(true);
    } catch (e) { toast('Order failed', e.message, 'err'); b.disabled = false; }
  }));
}

// ===================================================================== manager

function renderManagerShell() {
  S.view ||= 'overview';
  $('#app').innerHTML = `${topbar([['overview', '📊 Control room'], ['batches', '📦 Batches']], S.view)}
    <main class="page" id="main"></main>`;
  bindTopbar(v => { S.view = v; renderManagerShell(); });
  refreshManager(true);
  S.pollTimer = setInterval(() => refreshManager(false), S.meta.tickMs || 5000);
}

async function refreshManager(force) {
  try {
    S.ov = await api('/api/manager/overview');
  } catch (e) { if (force) toast('Could not load dashboard', e.message, 'err'); return; }
  updateClock(S.ov.simNow);
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT';
  if (!force && typing) return;
  renderManagerView();
}

function renderManagerView() {
  const main = $('#main');
  if (!main || !S.ov) return;
  const y = window.scrollY;
  destroyCharts();
  main.innerHTML = S.view === 'batches' ? batchesView() : overviewView();
  bindManagerView();
  drawSparklines();
  window.scrollTo(0, y);
}

function kpiTiles(k) {
  const tiles = [
    ['At risk', `${k.atRiskKg.toLocaleString()} <small>kg</small>`, 'Mid + low grade: must sell fast'],
    ['Rescued from waste', `${k.rescuedKg.toLocaleString()} <small>kg</small>`, 'Sold as flash / wholesale, or donated'],
    ['Disposed', `${k.disposedKg.toLocaleString()} <small>kg</small>`, 'Unsafe or expired'],
  ];
  return `<div class="kpis">${tiles.map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v tnum">${v}</div><div class="s">${s}</div></div>`).join('')}</div>`;
}

function pipelineStrip() {
  const o = S.ov;
  const last = o.aiRuns[0];
  const steps = [
    ['📡', 'Sensors', `${o.sensors.length} chillers & trucks, live`],
    ['⚗️', 'Shelf-life AI', `Physics model + ML (R² ${o.mlModel.r2})`],
    ['🧠', 'Claude grade', o.ai.available ? `${esc(o.ai.model)}${last ? ` · ${fmtTime(last.at)}` : ''}` : 'Rules fallback (no API key)'],
    ['🚚', 'Routing', 'Good · Mid · Low · Dispose'],
  ];
  return `<div class="card pipe-strip">${steps.map(([ic, t, m], i) => `
    <div class="ps ${i === 2 ? 'ai' : ''}"><span class="ic">${ic}</span><div><b>${t}</b><div class="small muted">${m}</div></div></div>`).join('<span class="arrow">→</span>')}
  </div>`;
}

function routesCard() {
  const k = S.ov.kpis.byGrade;
  return `<div class="card"><div class="card-head"><h3>Where the stock is going</h3><span class="small muted">kg by AI grade</span><span class="spacer"></span><button class="btn sm" data-goview="batches">See every batch →</button></div>
    <div class="card-body"><div class="routes">
      ${['good', 'mid', 'low', 'dispose'].map(g => `<div class="route g-${g}">
        ${gradeChip(g)}<span class="kg tnum">${(k[g] || 0).toLocaleString()} kg</span>
        <span class="ch">→ ${esc(S.ov.routes[g].channel)}</span><span class="d">${esc(S.ov.routes[g].description)}</span></div>`).join('')}
    </div></div></div>`;
}

function sensorState(s) {
  if (s.kind === 'truck' && s.status !== 'in-transit') return ['ok', s.status === 'returning' ? 'Returning for next load' : s.status];
  if (s.temp > s.setpoint + 6) return ['bad', 'Critical temperature'];
  if (s.temp > s.setpoint + 3) return ['bad', 'Too warm'];
  if (s.door) return ['warn', 'Door open'];
  if (s.rh < s.rhSet - 12 || s.rh > s.rhSet + 8) return ['warn', 'Humidity off'];
  return ['ok', 'Normal'];
}

function sensorsCard() {
  const o = S.ov;
  return `<div class="card"><div class="card-head"><h3>Live sensors</h3><span class="small muted">new reading every ${S.meta.simMinutesPerTick} simulated min</span></div>
    <div class="card-body">
      <div class="sensors">${o.sensors.map(s => {
        const [cls, label] = sensorState(s);
        return `<div class="card sensor ${cls === 'bad' ? 'bad' : ''}">
          <b style="font-size:14px">${s.kind === 'truck' ? '🚚' : '🏭'} ${esc(s.name)}</b>
          <div class="small muted">${esc(s.site)}${s.kind === 'truck' && s.status === 'in-transit' ? ` · ETA ${Math.max(0, s.etaH).toFixed(1)} h` : ''}</div>
          <div class="row"><span class="t tnum">${s.temp.toFixed(1)}°C</span><span class="spacer"></span><span class="small muted tnum">set ${s.setpoint}°C</span></div>
          <div class="spark"><canvas data-spark="${s.id}"></canvas></div>
          <div class="row"><span class="state ${cls}">${label}</span><span class="spacer"></span><span class="small muted">${s.batchCount} batches</span></div>
        </div>`;
      }).join('')}</div>
      <div class="sim-row">
        <span class="small"><b>Demo:</b> simulate an incident on</span>
        <select class="input" id="simSensor">${o.sensors.map(s => `<option value="${s.id}" ${S.simSensor === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <button class="btn sm" data-fault="compressor">❄️ Compressor failure</button>
        <button class="btn sm" data-fault="door">🚪 Door left open</button>
        <button class="btn sm" data-fault="">✓ Clear</button>
      </div>
    </div></div>`;
}

function alertItem(a) {
  const labels = { reroute: '🚚 Reroute', adjust: '🔧 Fix / adjust', inspect: '🔍 Inspect', ack: 'Acknowledge', donate: '🤝 Donate', prioritize: '🔥 Flash sale' };
  return `<div class="alert">
    <span class="sev ${a.severity}"></span>
    <div style="flex:1;min-width:0">
      <div class="row wrap" style="gap:8px"><span class="title">${esc(a.title)}</span><span class="chip neutral">${a.severity}</span>
        <span class="spacer"></span><span class="small muted">${fmtTime(a.createdAt)}</span></div>
      <div class="msg">${esc(a.message)}</div>
      <div class="rec">💡 <b>Recommended:</b> ${esc(a.recommendation)}</div>
      <div class="row wrap" style="gap:6px;margin-top:8px">${a.actions.map(x => `<button class="btn sm ${x === 'ack' ? '' : 'primary'}" data-alert="${a.id}" data-act="${x}">${labels[x] || x}</button>`).join('')}</div>
    </div></div>`;
}

function overviewView() {
  const o = S.ov;
  const open = o.alerts.filter(a => a.status === 'open');
  return `
    <div class="hello"><div><h1>Cold-chain control room</h1><p class="muted">${esc(S.user.businessName || 'Doha Central Cold Store')} · live</p></div>
      <span class="spacer"></span><button class="btn primary" data-runai>🧠 Run AI grading now</button></div>
    ${pipelineStrip()}
    ${kpiTiles(o.kpis)}
    <div class="dash-grid">
      ${sensorsCard()}
      <div class="card"><div class="card-head"><h3>🚨 Alerts & recommended actions</h3><span class="chip neutral">${open.length} open</span></div>
        <div class="alert-list">${open.map(alertItem).join('') || '<div class="empty">✓ All clear</div>'}</div></div>
    </div>
    <div style="margin-top:16px">${routesCard()}</div>
    <p class="small muted" style="margin-top:16px"><button class="link-btn" id="resetDemo">↺ Reset demo data</button></p>`;
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
  const actionBtns = b => b.status !== 'active' ? '' : `
    <div class="row" style="gap:4px">
      <button class="btn sm" title="Log inspection" data-bact="inspect" data-batch="${b.id}">🔍</button>
      ${b.grade !== 'low' ? `<button class="btn sm" title="Move to flash sale" data-bact="prioritize" data-batch="${b.id}">🔥</button>` : ''}
      ${!b.pred.safetyBreach ? `<button class="btn sm" title="Donate to food-rescue partner" data-bact="donate" data-batch="${b.id}">🤝</button>` : ''}
      <button class="btn sm danger" title="Dispose" data-bact="dispose" data-batch="${b.id}">🗑️</button></div>`;
  return `
    <div class="hello"><div><h1>Batches</h1><p class="muted">Recalculated shelf life, AI grade and destination for every batch. Most urgent first. Click a row to see how the AI got there.</p></div>
      <span class="spacer"></span><button class="btn primary" data-runai>🧠 Run AI grading now</button></div>
    <div class="filters">
      <select class="input" data-filter="grade"><option value="all">All grades</option>${Object.keys(GRADE).map(g => `<option value="${g}" ${f.grade === g ? 'selected' : ''}>${GRADE[g].label}</option>`).join('')}</select>
      <select class="input" data-filter="category"><option value="all">All categories</option>${S.meta.categories.map(c => `<option value="${c.id}" ${f.category === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <input class="input" data-filter="q" placeholder="Search batch, product, location…" value="${esc(f.q)}" />
      <span class="small muted">${list.length} batches</span>
    </div>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Batch</th><th>Where</th><th>Qty</th><th>Shelf life left</th><th>AI grade</th><th>Why & what to do</th><th>Going to</th><th></th></tr></thead>
      <tbody>${list.map(b => `
        <tr data-row="${b.id}" style="cursor:pointer">
          <td><b>${b.product.icon} ${esc(b.product.name)}</b><div class="small muted">${b.id} · ${esc(b.origin)}</div></td>
          <td class="small">${b.locationKind === 'truck' ? '🚚' : '🏭'} ${esc(b.location)}</td>
          <td class="tnum">${b.status === 'active' ? b.qty : b.disposedQty} ${b.product.unit}</td>
          <td>${lifeBar(b)}<div class="small muted">risk ${b.pred.risk}/100</div></td>
          <td>${gradeChip(b.grade)}<div class="small muted">${b.gradeSource === 'claude' ? '🧠 Claude' : esc(b.gradeSource)}</div></td>
          <td class="small" style="max-width:320px">${esc(b.reason)}<div><b>→ ${esc(b.action)}</b></div></td>
          <td class="small" style="max-width:170px">${esc(S.ov.routes[b.grade].channel)}</td>
          <td>${actionBtns(b)}</td>
        </tr>
        ${S.expanded.has(b.id) ? `<tr class="detail"><td colspan="8">${batchDetail(b)}</td></tr>` : ''}`).join('')}
      </tbody></table></div>`;
}

function batchDetail(b) {
  const p = b.pred, e = b.exposure;
  const cells = [
    ['① Physics model: life left', `${p.kineticRemainingH} h`],
    ['② ML correction factor', `× ${p.mlRatio}`],
    ['③ Prediction at current temp', `${p.remainingH} h ± ${p.uncertaintyH}`],
    ['Ageing speed right now', `${p.currentRate}× normal`],
    ['Hours above safe temp', `${e.abuseH.toFixed(1)} h (> ${b.product.maxSafeTemp} °C)`],
    ['Max temperature seen', `${e.maxTemp.toFixed(1)} °C`],
    ['Rule baseline grade', GRADE[p.ruleGrade].label],
  ];
  return `<div class="break">${cells.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

function bindManagerView() {
  const main = $('#main');
  $$('[data-goview]', main).forEach(b => b.addEventListener('click', () => { S.view = b.dataset.goview; renderManagerShell(); }));
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
  $('#simSensor')?.addEventListener('change', e => { S.simSensor = e.target.value; e.target.blur(); });
  $$('[data-fault]', main).forEach(b => b.addEventListener('click', async () => {
    await api(`/api/manager/sensors/${S.simSensor}/fault`, { body: { fault: b.dataset.fault || null } });
    toast(b.dataset.fault ? 'Incident started' : 'Fault cleared', 'Watch the sensor, alerts and shelf-life predictions react.');
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
  $('#resetDemo')?.addEventListener('click', async () => {
    if (!confirm('Reset all demo data (batches, alerts, orders)? Accounts are kept.')) return;
    const r = await api('/api/manager/reset', { body: {} });
    S.token = r.token; localSet('fr_token', r.token);
    toast('Demo reset', 'Fresh stock loaded and scenario restarted.');
    refreshManager(true);
  });
}

// ===================================================================== charts

function destroyCharts() {
  for (const c of Object.values(S.charts)) c.destroy();
  S.charts = {};
}

function drawSparklines() {
  if (typeof Chart === 'undefined') return;
  for (const cv of $$('[data-spark]')) {
    const s = S.ov.sensors.find(x => x.id === cv.dataset.spark);
    const h = s.history.slice(-48);
    const [cls] = sensorState(s);
    S.charts[`sp-${s.id}`] = new Chart(cv, {
      type: 'line',
      data: {
        labels: h.map(r => fmtTime(r.t)),
        datasets: [
          { data: h.map(r => r.temp), borderColor: cls === 'bad' ? cssVar('--critical') : cssVar('--accent'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: .3 },
          { data: h.map(() => s.setpoint), borderColor: cssVar('--muted'), borderWidth: 1, borderDash: [3, 3], pointRadius: 0, pointHoverRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { filter: i => i.datasetIndex === 0, displayColors: false, callbacks: { label: c => `${c.parsed.y} °C` } } },
        scales: { x: { display: false }, y: { display: false, suggestedMin: s.setpoint - 2, suggestedMax: s.setpoint + 4 } },
      },
    });
  }
}

boot();
