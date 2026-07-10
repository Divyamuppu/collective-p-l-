const app = document.getElementById('app');

const COLORS = { revenue: '#5B4FE9', expenses: '#F2994A', profit: '#17A34A', grid: '#E7E3D8' };

// Registered globally, but disabled by default (see chartDefaults below) -
// only the expense pie chart turns it on, so line/bar charts stay unlabeled.
if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);
Chart.defaults.set('plugins.datalabels', { display: false });
const CHART_FONT_BODY = 'Inter, sans-serif';
const CHART_FONT_MONO = "'IBM Plex Mono', monospace";

function money(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);
}

function tone(n) {
  return n >= 0 ? 'positive' : 'negative';
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Auth ----------

function getToken() {
  return localStorage.getItem('pnl-token');
}

function getUser() {
  try {
    const raw = localStorage.getItem('pnl-user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setAuth(token, user) {
  localStorage.setItem('pnl-token', token);
  localStorage.setItem('pnl-user', JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem('pnl-token');
  localStorage.removeItem('pnl-user');
}

function isLoggedIn() {
  return !!getToken();
}

// Only EXEC and FINANCE can delete - matches the backend's requireRole check.
// Hiding the buttons is a UX nicety; the server enforces this regardless.
function canDelete() {
  const user = getUser();
  return !!user && (user.role === 'EXEC' || user.role === 'FINANCE');
}

// User management (creating/editing logins) is EXEC-only, matching the server.
function canManageUsers() {
  const user = getUser();
  return !!user && user.role === 'EXEC';
}

function authHeaders(extra) {
  const token = getToken();
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function handleAuthFailure(res) {
  if (res.status === 401) {
    clearAuth();
    navigate('/');
    throw new Error('Your session expired - please log in again');
  }
}

async function get(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) await handleAuthFailure(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${path}`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) await handleAuthFailure(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${path}`);
  }
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) await handleAuthFailure(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${path}`);
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(path, { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) await handleAuthFailure(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${path}`);
  }
  return res.json();
}

async function uploadFile(path, file, fieldName) {
  const form = new FormData();
  form.append(fieldName, file);
  const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: form });
  if (res.status === 401) await handleAuthFailure(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${path}`);
  }
  return res.json();
}

// ---------- Dashboard layout customization ----------
// Layout is saved to this browser's localStorage, so each person using their
// own browser on this machine keeps their own arrangement - there's no login
// system in this app, so "per user" naturally means "per browser" here.

const DEFAULT_CARD_ORDER = ['total-revenue', 'total-expenses', 'net-profit', 'profit-margin', 'active-projects', 'verticals-count'];
const DEFAULT_WIDGET_ORDER = ['expense-chart', 'trend-chart', 'vertical-combo-chart', 'profitability'];
const DEFAULT_WIDGET_SIZES = { 'trend-chart': 'wide' };

function loadLayout(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveLayout(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private browsing, etc.) - layout just won't persist
  }
}

// Keeps any ids the user hasn't touched, drops ids that no longer exist,
// and appends any new ids that weren't in the saved layout yet.
function reconcileOrder(defaultOrder, savedOrder) {
  if (!Array.isArray(savedOrder)) return [...defaultOrder];
  const kept = savedOrder.filter((id) => defaultOrder.includes(id));
  const missing = defaultOrder.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

function swapInArray(arr, a, b) {
  const i = arr.indexOf(a);
  const j = arr.indexOf(b);
  if (i === -1 || j === -1) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

// Generic drag-to-reorder: dragging is only initiated from `handleSelector`
// (e.g. a widget's title bar), so clicking buttons/links/inputs inside a
// widget's body still works normally instead of being hijacked by the drag.
function enableDragReorder(container, itemSelector, handleSelector, onDrop) {
  if (!container) return;
  let draggedId = null;

  container.querySelectorAll(itemSelector).forEach((item) => {
    const handle = handleSelector ? item.querySelector(handleSelector) : item;
    if (!handle) return;

    handle.setAttribute('draggable', 'true');
    handle.addEventListener('dragstart', (e) => {
      draggedId = item.dataset.dragId;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => item.classList.remove('dragging'));

    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = item.dataset.dragId;
      if (!draggedId || draggedId === targetId) return;
      onDrop(draggedId, targetId);
    });
  });
}

function card(label, value, toneClass, kind) {
  const extraClass = kind === 'profit' && toneClass === 'negative' ? 'card--loss-state' : '';
  return `<div class="card card--${kind || 'default'} ${extraClass}"><div class="label">${label}</div><div class="value ${toneClass || ''}">${value}</div></div>`;
}

function marginCard(label, pct) {
  const t = tone(pct);
  const width = Math.min(Math.abs(pct), 100);
  return `
    <div class="card card--margin">
      <div class="label">${label}</div>
      <div class="value ${t}">${pct}%</div>
      <div class="margin-bar-track"><div class="margin-bar-fill ${t}" style="width:${width}%"></div></div>
    </div>
  `;
}

function navigate(url) {
  history.pushState({}, '', url);
  render();
}

// Intercept clicks on internal links so navigation doesn't reload the page
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

window.addEventListener('popstate', render);

function updateRefreshedLabel() {
  const el = document.getElementById('refreshed-at');
  if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function updateUserInfo() {
  const el = document.getElementById('user-info');
  if (!el) return;
  const user = getUser();
  if (!user) { el.innerHTML = ''; return; }
  el.innerHTML = `${escapeAttr(user.name)} <span class="role-badge">${user.role}</span> <button type="button" id="logout-btn" class="logout-btn">Log out</button>`;
  document.getElementById('logout-btn').addEventListener('click', () => {
    clearAuth();
    navigate('/');
  });
}

function playFadeIn() {
  app.classList.remove('fade-in');
  void app.offsetWidth; // restart the animation on every view change
  app.classList.add('fade-in');
}

async function updateSidebar() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;

  if (!isLoggedIn()) {
    shell.classList.add('no-sidebar');
    return;
  }
  shell.classList.remove('no-sidebar');

  const params = new URLSearchParams(location.search);
  const view = params.get('view') || 'company';
  const activeVerticalId = view === 'vertical' ? params.get('id') : null;

  const dashboardLink = document.getElementById('nav-dashboard');
  if (dashboardLink) dashboardLink.classList.toggle('active', view === 'company');

  const vendorsLink = document.getElementById('nav-vendors');
  if (vendorsLink) vendorsLink.classList.toggle('active', view === 'vendors');

  const usersLink = document.getElementById('nav-users');
  if (usersLink) {
    usersLink.classList.toggle('active', view === 'users');
    usersLink.style.display = canManageUsers() ? '' : 'none';
  }

  const container = document.getElementById('sidebar-verticals');
  if (!container) return;

  try {
    const verticals = await get('/api/verticals');
    container.innerHTML = verticals
      .map((v) => `
        <a href="/?view=vertical&id=${v.id}" data-nav class="sidebar-link ${v.id === activeVerticalId ? 'active' : ''}">
          <span class="sidebar-link-icon">&#9642;</span> ${v.name}
        </a>
      `)
      .join('');
  } catch {
    // sidebar nav is a nice-to-have - if it fails to load, the rest of the app still works
  }
}

async function render() {
  updateUserInfo();
  updateSidebar();

  if (!isLoggedIn()) {
    renderLogin();
    playFadeIn();
    return;
  }

  const params = new URLSearchParams(location.search);
  const view = params.get('view') || 'company';

  try {
    if (view === 'vertical') {
      setResetLayoutSlot(false);
      await renderVertical(params.get('id'));
    } else if (view === 'project') {
      setResetLayoutSlot(false);
      await renderProject(params.get('id'));
    } else if (view === 'vendors') {
      setResetLayoutSlot(false);
      await renderVendors();
    } else if (view === 'users') {
      setResetLayoutSlot(false);
      await renderUsers();
    } else {
      await renderCompany();
    }
    updateRefreshedLabel();
    playFadeIn();
  } catch (err) {
    app.innerHTML = `<p class="negative">Could not load data: ${err.message}</p>`;
    playFadeIn();
  }
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-shell">
      <form id="login-form" class="login-card">
        <div class="eyebrow">Sign in</div>
        <h1>Collective P&amp;L</h1>
        <p class="panel-sub">Log in to view and manage the dashboard.</p>
        <div id="login-error" class="login-error" style="display:none"></div>
        <label class="login-label">Email
          <input type="email" name="email" required autocomplete="username" value="admin@company.com" />
        </label>
        <label class="login-label">Password
          <input type="password" name="password" required autocomplete="current-password" value="password123" />
        </label>
        <button type="submit">Log in</button>
        <p class="login-hint">Demo accounts: admin@company.com / finance@company.com / pm@company.com, all with password "password123"</p>
      </form>
    </div>
  `;

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const errorEl = document.getElementById('login-error');
    errorEl.style.display = 'none';
    try {
      const { token, user } = await post('/api/auth/login', {
        email: form.get('email'),
        password: form.get('password'),
      });
      setAuth(token, user);
      navigate('/');
    } catch (err) {
      errorEl.textContent = err.message || 'Login failed';
      errorEl.style.display = 'block';
    }
  });
}

// ---------- Chart helpers ----------

function baseScales(currency) {
  return {
    y: {
      beginAtZero: true,
      ticks: { font: { family: CHART_FONT_MONO, size: 11 }, callback: currency ? (v) => '₹' + (v / 1000) + 'K' : undefined },
      grid: { color: COLORS.grid },
    },
    x: {
      ticks: { font: { family: CHART_FONT_MONO, size: 11 } },
      grid: { display: false },
    },
  };
}

function drawTrendChart(canvasId, trend) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  new Chart(el.getContext('2d'), {
    type: 'line',
    data: {
      labels: trend.map((t) => t.label),
      datasets: [
        { label: 'Revenue', data: trend.map((t) => t.revenue), borderColor: COLORS.revenue, backgroundColor: 'rgba(91,79,233,0.10)', fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: COLORS.revenue },
        { label: 'Expenses', data: trend.map((t) => t.expenses), borderColor: COLORS.expenses, backgroundColor: 'rgba(242,153,74,0.10)', fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: COLORS.expenses },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end', labels: { font: { family: CHART_FONT_BODY, size: 12 }, usePointStyle: true, boxWidth: 8 } } },
      scales: baseScales(true),
    },
  });
}

function drawExpenseBarChart(canvasId, breakdown) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  // breakdown is now a dynamic array of { key, name, amount }, sorted by
  // the server, since expense categories are user-defined, not fixed.
  const entries = [...breakdown].sort((a, b) => b.amount - a.amount);

  const pieColors = ['#5B4FE9', '#F2994A', '#8B5CF6', '#0F9B8E', '#E11D48', '#0EA5E9', '#D97706', '#DB2777'];

  new Chart(el.getContext('2d'), {
    type: 'pie',
    data: {
      labels: entries.map((e) => e.name),
      datasets: [{
        data: entries.map((e) => e.amount),
        backgroundColor: entries.map((_, i) => pieColors[i % pieColors.length]),
        borderColor: '#FFFFFF',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { font: { family: CHART_FONT_BODY, size: 12 }, usePointStyle: true, boxWidth: 8, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `${ctx.label}: ₹${ctx.parsed.toLocaleString('en-IN')} (${pct}%)`;
            },
          },
        },
        datalabels: {
          display: true,
          color: '#FFFFFF',
          font: { family: CHART_FONT_MONO, size: 11, weight: '600' },
          textAlign: 'center',
          formatter: (value, ctx) => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
            if (total === 0 || value === 0) return '';
            const pct = (value / total) * 100;
            if (pct < 5) return ''; // hide labels on slivers too thin to read
            return [`₹${Math.round(value).toLocaleString('en-IN')}`, `${pct.toFixed(0)}%`];
          },
        },
      },
    },
  });
}

function drawVerticalComboChart(canvasId, revenueByVertical, expensesByVertical) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: revenueByVertical.map((r) => r.vertical),
      datasets: [
        { label: 'Revenue', data: revenueByVertical.map((r) => r.revenue), backgroundColor: COLORS.revenue, borderRadius: 5, maxBarThickness: 20 },
        { label: 'Expenses', data: expensesByVertical.map((e) => e.expenses), backgroundColor: COLORS.expenses, borderRadius: 5, maxBarThickness: 20 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', align: 'end', labels: { font: { family: CHART_FONT_BODY, size: 12 }, usePointStyle: true, boxWidth: 8 } } },
      scales: baseScales(true),
    },
  });
}

// ---------- Company dashboard ----------

let companySettingsOpen = false;

async function renderCompany() {
  const params = new URLSearchParams(location.search);
  const vsel = params.get('vsel');

  const verticals = await get('/api/verticals');

  if (vsel) {
    let vdata;
    try {
      vdata = await get(`/api/dashboard/vertical/${vsel}`);
    } catch {
      // the selected vertical may have just been deleted - fall back to the overview
      navigate('/?view=company');
      return;
    }
    renderCompanyShell({ verticals, vsel, mode: 'vertical', vdata });
  } else {
    const [data, trend] = await Promise.all([get('/api/dashboard/company'), get('/api/dashboard/company/trend')]);
    renderCompanyShell({ verticals, vsel: null, mode: 'overview', data, trend });
  }
}

function verticalsPanelHtml(verticals, vsel) {
  if (!verticals.length) return '<p class="muted">No verticals yet - add one above.</p>';
  return verticals
    .map((v) => `
      <div class="v-row ${v.id === vsel ? 'active' : ''}">
        <a href="/?view=company&vsel=${v.id}" data-nav class="v-row-link">${v.name}</a>
        <div class="row-menu">
          <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="vertical-${v.id}" title="Actions" aria-label="Actions">&#8942;</button>
          <div class="row-menu-list" id="menu-vertical-${v.id}">
            <button type="button" data-edit-vertical="${v.id}" data-name="${escapeAttr(v.name)}">Edit</button>
            ${canDelete() ? `<button type="button" class="danger" data-delete-vertical="${v.id}" data-name="${escapeAttr(v.name)}">Delete</button>` : ''}
          </div>
        </div>
      </div>
    `)
    .join('');
}

function renderCompanyShell(ctx) {
  const { verticals, vsel } = ctx;

  const rightPaneHtml = ctx.mode === 'vertical'
    ? `
      <div class="workspace-vertical-heading">
        <div class="row-actions">
          <a href="/?view=company" data-nav class="icon-btn">&larr; Back to overview</a>
          <a href="/?view=vertical&id=${vsel}" data-nav class="icon-btn">Open full page</a>
        </div>
      </div>
      ${verticalDetailBodyHtml(ctx.vdata)}
    `
    : companyOverviewHtml(ctx.data);

  app.innerHTML = `
    <div class="company-view">
      <div class="dashboard-heading">
        <div>
          <div class="eyebrow">Company-wide</div>
          <h1>Company dashboard</h1>
        </div>
        ${canManageUsers() ? `<button type="button" class="icon-btn icon-only" id="company-settings-toggle" title="Settings" aria-label="Settings">&#9881;</button>` : ''}
      </div>

      ${companySettingsOpen && canManageUsers() ? `
        <div class="panel settings-panel danger-zone">
          <h2>Danger zone</h2>
          <p class="panel-sub">This deletes every vertical, project, revenue/expense entry, and vendor - including the seeded sample data - so you can start from a genuinely empty workspace. Logins are kept, so you won't be locked out. This can't be undone.</p>
          <button type="button" class="icon-btn danger" id="reset-workspace-btn">Clear all workspace data</button>
        </div>
      ` : ''}

      <div class="verticals-workspace">
        <aside class="panel verticals-panel">
          <h2>Verticals</h2>
          <form id="vertical-form" class="entry-form entry-form--stacked">
            <input type="text" name="name" placeholder="Vertical name" required />
            <input type="text" name="code" placeholder="Short code (e.g. HR)" required />
            <button type="submit">Add vertical</button>
          </form>
          <div class="verticals-list">${verticalsPanelHtml(verticals, vsel)}</div>
        </aside>
        <div class="workspace-main">${rightPaneHtml}</div>
      </div>
    </div>
  `;

  document.getElementById('company-settings-toggle')?.addEventListener('click', () => {
    companySettingsOpen = !companySettingsOpen;
    renderCompany();
  });

  document.getElementById('reset-workspace-btn')?.addEventListener('click', async () => {
    const first = window.confirm('This permanently deletes ALL verticals, projects, revenue, expenses, and vendors. Continue?');
    if (!first) return;
    const second = window.confirm('Really sure? There is no undo for this.');
    if (!second) return;
    await post('/api/workspace/reset', {});
    companySettingsOpen = false;
    navigate('/?view=company');
  });

  // Add-vertical form (always present, regardless of which vertical is selected)
  document.getElementById('vertical-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await post('/api/verticals', { name: form.get('name'), code: form.get('code') });
    renderCompany();
  });

  // Edit/delete for each row in the Verticals list
  document.querySelectorAll('[data-edit-vertical]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = window.prompt('Rename vertical', btn.dataset.name);
      if (!name || name.trim() === '' || name === btn.dataset.name) return;
      await patch(`/api/verticals/${btn.dataset.editVertical}`, { name: name.trim() });
      renderCompany();
    });
  });
  document.querySelectorAll('[data-delete-vertical]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm(`Delete "${btn.dataset.name}"? This also deletes every project and entry inside it. This can't be undone.`);
      if (!ok) return;
      await del(`/api/verticals/${btn.dataset.deleteVertical}`);
      if (btn.dataset.deleteVertical === vsel) navigate('/?view=company');
      else renderCompany();
    });
  });

  setResetLayoutSlot(ctx.mode === 'overview');

  if (ctx.mode === 'vertical') {
    wireVerticalDetailEvents(vsel, ctx.vdata, () => renderCompany());
  } else {
    wireCompanyOverview(ctx.data, ctx.trend);
  }
}

function companyOverviewHtml(data) {
  const cardOrder = reconcileOrder(DEFAULT_CARD_ORDER, loadLayout('pnl-card-order', null));
  const widgetLayout = loadLayout('pnl-widget-layout', {}) || {};
  const widgetOrder = reconcileOrder(DEFAULT_WIDGET_ORDER, widgetLayout.order);
  const widgetSizes = { ...DEFAULT_WIDGET_SIZES, ...(widgetLayout.sizes || {}) };

  const cardHtmlById = {
    'total-revenue': card('Total revenue', money(data.totalRevenue), '', 'revenue'),
    'total-expenses': card('Total expenses', money(data.totalExpenses), '', 'expenses'),
    'net-profit': card('Net profit/loss', money(data.netProfit), tone(data.netProfit), 'profit'),
    'profit-margin': marginCard('Profit margin', data.profitMarginPct),
    'active-projects': card('Active projects', data.activeProjectCount, '', 'count'),
    'verticals-count': card('Verticals', data.verticalCount, '', 'count-alt'),
  };

  const widgetTitleById = {
    'expense-chart': 'Expense breakdown',
    'trend-chart': 'Revenue trend',
    'vertical-combo-chart': 'Revenue &amp; expenses by vertical',
    profitability: 'Profitability',
  };

  const widgetBodyById = {
    'expense-chart': `
      <p class="panel-sub">By category, company-wide</p>
      <div class="chart-box flex-fill"><canvas id="expense-chart"></canvas></div>
    `,
    'trend-chart': `
      <p class="panel-sub">Last 6 months</p>
      <div class="chart-box flex-fill"><canvas id="trend-chart"></canvas></div>
    `,
    'vertical-combo-chart': `
      <p class="panel-sub">Current totals</p>
      <div class="chart-box flex-fill"><canvas id="vertical-combo-chart"></canvas></div>
    `,
    profitability: `
      <p class="panel-sub">Best and worst projects</p>
      <div class="split-lists">
        ${compactProjectList('Top profitable', data.topProfitableProjects)}
        ${compactProjectList('Loss-making', data.lossMakingProjects)}
      </div>
    `,
  };

  const cardsHtml = cardOrder
    .map((id) => `<div class="card-slot" draggable="true" data-drag-id="${id}">${cardHtmlById[id]}</div>`)
    .join('');

  const widgetsHtml = widgetOrder
    .map((id) => `
      <div class="widget panel ${widgetSizes[id] === 'wide' ? 'widget--wide' : ''}" data-drag-id="${id}">
        <div class="widget-header">
          <h2>${widgetTitleById[id]}</h2>
          <div class="widget-controls">
            <button type="button" class="widget-btn" data-resize-id="${id}" title="Toggle width">&#10530;</button>
            <span class="drag-handle" title="Drag to move">&#8942;&#8942;</span>
          </div>
        </div>
        <div class="widget-body">${widgetBodyById[id]}</div>
      </div>
    `)
    .join('');

  return `
    <div class="cards">${cardsHtml}</div>
    <div class="widget-grid">${widgetsHtml}</div>
  `;
}

function wireCompanyOverview(data, trend) {
  drawTrendChart('trend-chart', trend);
  drawExpenseBarChart('expense-chart', data.expenseBreakdown);
  drawVerticalComboChart('vertical-combo-chart', data.revenueByVertical, data.expensesByVertical);

  // Drag-to-reorder for the KPI cards - whole card is the drag handle, there's
  // nothing interactive inside a card to conflict with.
  enableDragReorder(document.querySelector('.cards'), '.card-slot', null, (draggedId, targetId) => {
    const order = reconcileOrder(DEFAULT_CARD_ORDER, loadLayout('pnl-card-order', null));
    swapInArray(order, draggedId, targetId);
    saveLayout('pnl-card-order', order);
    renderCompany();
  });

  // Drag-to-reorder for widgets - only the title bar (.widget-header) is the
  // handle, so links/buttons/inputs inside each widget's body keep working.
  enableDragReorder(document.querySelector('.widget-grid'), '.widget', '.widget-header', (draggedId, targetId) => {
    const layout = loadLayout('pnl-widget-layout', {}) || {};
    const order = reconcileOrder(DEFAULT_WIDGET_ORDER, layout.order);
    swapInArray(order, draggedId, targetId);
    saveLayout('pnl-widget-layout', { order, sizes: layout.sizes || {} });
    renderCompany();
  });

  // Resize (width toggle) for each widget
  document.querySelectorAll('[data-resize-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.resizeId;
      const layout = loadLayout('pnl-widget-layout', {}) || {};
      const order = reconcileOrder(DEFAULT_WIDGET_ORDER, layout.order);
      const sizes = { ...DEFAULT_WIDGET_SIZES, ...(layout.sizes || {}) };
      sizes[id] = sizes[id] === 'wide' ? 'normal' : 'wide';
      saveLayout('pnl-widget-layout', { order, sizes });
      renderCompany();
    });
  });
}

function setResetLayoutSlot(show) {
  const slot = document.getElementById('reset-layout-slot');
  if (!slot) return;
  if (!show) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `<button type="button" id="reset-layout-btn" class="icon-btn">Reset to default layout</button>`;
  document.getElementById('reset-layout-btn').addEventListener('click', () => {
    localStorage.removeItem('pnl-card-order');
    localStorage.removeItem('pnl-widget-layout');
    renderCompany();
  });
}

function compactProjectList(title, projects) {
  if (!projects.length) return `<div class="split-list"><h3>${title}</h3><p class="muted">None</p></div>`;
  return `
    <div class="split-list">
      <h3>${title}</h3>
      ${projects.map((p) => `
        <div class="split-list-row">
          <a class="row-link" data-nav href="/?view=project&id=${p.projectId}">${p.projectName}</a>
          <span class="num ${tone(p.netProfit)}">${money(p.netProfit)}</span>
        </div>`).join('')}
    </div>
  `;
}

// ---------- Vertical dashboard ----------

// Shared between the standalone Vertical Dashboard page and the inline
// detail pane on the Company Dashboard's Verticals workspace, so both stay
// in sync instead of duplicating this markup two different ways.
function verticalDetailBodyHtml(data) {
  return `
    <div class="cards">
      ${card('Total revenue', money(data.totalRevenue), '', 'revenue')}
      ${card('Total expenses', money(data.totalExpenses), '', 'expenses')}
      ${card('Net profit/loss', money(data.netProfit), tone(data.netProfit), 'profit')}
      ${marginCard('Profit margin', data.profitMarginPct)}
    </div>

    <div class="panel vertical-chart-panel">
      <h2>Revenue vs. expenses by project</h2>
      <div class="chart-box short"><canvas id="project-combo-chart"></canvas></div>
    </div>

    <div class="panel table-panel">
      <h2>Projects (${data.activeProjectCount} active)</h2>
      <table class="project-table">
        <tr><th>Project</th><th>Revenue</th><th>Expenses</th><th>Net P/L</th><th>Margin</th></tr>
        ${data.projects.map((p) => `
          <tr>
            <td><a class="row-link" data-nav href="/?view=project&id=${p.projectId}">${p.projectName}</a></td>
            <td class="num">${money(p.totalRevenue)}</td>
            <td class="num">${money(p.totalExpenses)}</td>
            <td class="num ${tone(p.netProfit)}">${money(p.netProfit)}</td>
            <td class="num">${p.profitMarginPct}%</td>
          </tr>`).join('')}
      </table>
    </div>

    <div class="panel compact-panel">
      <h2>Add a new project</h2>
      <form id="project-form" class="entry-form">
        <input type="text" name="name" placeholder="Project name" required />
        <button type="submit">Create project</button>
      </form>
      ${data.projects.length ? `
        <div class="manage-row">
          <select id="project-select">
            ${data.projects.map((p) => `<option value="${p.projectId}" data-name="${escapeAttr(p.projectName)}">${p.projectName}</option>`).join('')}
          </select>
          <div class="row-menu">
            <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="project-manage" title="Actions" aria-label="Actions">&#8942;</button>
            <div class="row-menu-list" id="menu-project-manage">
              <button type="button" id="edit-project-btn">Edit</button>
              ${canDelete() ? `<button type="button" class="danger" id="delete-project-btn">Delete</button>` : ''}
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function wireVerticalDetailEvents(id, data, onChange) {
  document.getElementById('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await post('/api/projects', { name: form.get('name'), verticalId: id });
    onChange(); // refetch - the new project now shows up and rolls into the totals above
  });

  const projectSelect = document.getElementById('project-select');
  if (projectSelect) {
    document.getElementById('edit-project-btn').addEventListener('click', async () => {
      const opt = projectSelect.options[projectSelect.selectedIndex];
      if (!opt) return;
      const name = window.prompt('Rename project', opt.dataset.name);
      if (!name || name.trim() === '' || name === opt.dataset.name) return;
      await patch(`/api/projects/${opt.value}`, { name: name.trim() });
      onChange();
    });

    document.getElementById('delete-project-btn')?.addEventListener('click', async () => {
      const opt = projectSelect.options[projectSelect.selectedIndex];
      if (!opt) return;
      const ok = window.confirm(`Delete "${opt.dataset.name}"? This also deletes its revenue and expense history. This can't be undone.`);
      if (!ok) return;
      await del(`/api/projects/${opt.value}`);
      onChange();
    });
  }

  if (data.projects.length) {
    new Chart(document.getElementById('project-combo-chart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: data.projects.map((p) => p.projectName),
        datasets: [
          { label: 'Revenue', data: data.projects.map((p) => p.totalRevenue), backgroundColor: COLORS.revenue, borderRadius: 5, maxBarThickness: 24 },
          { label: 'Expenses', data: data.projects.map((p) => p.totalExpenses), backgroundColor: COLORS.expenses, borderRadius: 5, maxBarThickness: 24 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { font: { family: CHART_FONT_BODY, size: 12 }, usePointStyle: true, boxWidth: 8 } } },
        scales: baseScales(true),
      },
    });
  }
}

async function renderVertical(id) {
  const data = await get(`/api/dashboard/vertical/${id}`);

  app.innerHTML = `
    <div class="vertical-view">
      <div class="breadcrumb"><a data-nav href="/">&larr; Company</a></div>
      ${verticalDetailBodyHtml(data)}
    </div>
  `;

  wireVerticalDetailEvents(id, data, () => renderVertical(id));
}

// ---------- Project dashboard ----------

async function renderProject(id) {
  const [data, categories, revenueEntries, expenseEntries] = await Promise.all([
    get(`/api/projects/${id}/pnl`),
    get('/api/expense-categories'),
    get(`/api/projects/${id}/revenue`),
    get(`/api/projects/${id}/expenses`),
  ]);

  const categoryNameByKey = Object.fromEntries(categories.map((c) => [c.key, c.name]));
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  app.innerHTML = `
    <div class="breadcrumb"><a data-nav href="/">Company</a> / <a data-nav href="/?view=vertical&id=${data.verticalId}">Vertical</a> / ${data.projectName}</div>
    <div class="eyebrow">Project</div>
    <h1>${data.projectName}</h1>
    <div class="cards">
      ${card('Revenue', money(data.totalRevenue), '', 'revenue')}
      ${card('Total expenses', money(data.totalExpenses), '', 'expenses')}
      ${card('Net profit/loss', money(data.netProfit), tone(data.netProfit), 'profit')}
      ${marginCard('Profit margin', data.profitMarginPct)}
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>Expense breakdown</h2>
        <div class="chart-box short"><canvas id="project-expense-chart"></canvas></div>
      </div>
      <div class="panel">
        <h2>Expense breakdown</h2>
        <p class="panel-sub">Exact figures</p>
        <table>
          ${data.costBreakdown.length
            ? data.costBreakdown.map((c) => `<tr><td>${c.name}</td><td class="num">${money(c.amount)}</td></tr>`).join('')
            : `<tr><td class="muted">No expenses logged yet</td><td></td></tr>`}
          <tr><td><strong>Total expenses</strong></td><td class="num"><strong>${money(data.totalExpenses)}</strong></td></tr>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>Revenue entries</h2>
        <form id="revenue-form" class="entry-form">
          <input type="number" name="amount" placeholder="Amount" required step="0.01" />
          <input type="text" name="source" placeholder="Source (optional)" />
          <button type="submit">Add</button>
        </form>
        ${revenueEntries.length ? `
          <table class="entry-list-table">
            ${revenueEntries.map((r) => `
              <tr>
                <td>${fmtDate(r.entryDate)}</td>
                <td>${r.source || '<span class="muted">-</span>'}</td>
                <td class="num">${money(r.amount)}</td>
                <td class="num">
                  <div class="row-menu">
                    <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="revenue-${r.id}" title="Actions" aria-label="Actions">&#8942;</button>
                    <div class="row-menu-list" id="menu-revenue-${r.id}">
                      <button type="button" data-edit-revenue="${r.id}" data-amount="${r.amount}" data-source="${escapeAttr(r.source || '')}">Edit</button>
                      <button type="button" class="danger" data-delete-revenue="${r.id}">Delete</button>
                    </div>
                  </div>
                </td>
              </tr>
            `).join('')}
          </table>
        ` : `<p class="muted">No revenue logged yet.</p>`}
      </div>

      <div class="panel">
        <h2>Expense entries</h2>
        <form id="expense-form" class="entry-form">
          <input type="number" name="amount" placeholder="Amount" required step="0.01" />
          <select name="category" id="expense-category-select">
            ${categories.map((c) => `<option value="${c.key}">${c.name}</option>`).join('')}
          </select>
          <button type="submit">Add</button>
        </form>
        <form id="add-category-form" class="entry-form">
          <input type="text" name="name" placeholder="New expense type (e.g. Travel)" />
          <button type="submit">Add type</button>
        </form>
        ${categories.length ? `
          <div class="manage-row">
            <select id="category-manage-select">
              ${categories.map((c) => `<option value="${c.id}" data-name="${escapeAttr(c.name)}">${c.name}</option>`).join('')}
            </select>
            <div class="row-menu">
              <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="category-manage" title="Actions" aria-label="Actions">&#8942;</button>
              <div class="row-menu-list" id="menu-category-manage">
                <button type="button" id="edit-category-btn">Edit</button>
                <button type="button" class="danger" id="delete-category-btn">Delete</button>
              </div>
            </div>
          </div>
        ` : ''}
        ${expenseEntries.length ? `
          <table class="entry-list-table">
            ${expenseEntries.map((e) => `
              <tr>
                <td>${fmtDate(e.entryDate)}</td>
                <td>${categoryNameByKey[e.category] || e.category}</td>
                <td class="num">${money(e.amount)}</td>
                <td class="num">
                  <div class="row-menu">
                    <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="expense-${e.id}" title="Actions" aria-label="Actions">&#8942;</button>
                    <div class="row-menu-list" id="menu-expense-${e.id}">
                      <button type="button" data-edit-expense="${e.id}" data-amount="${e.amount}" data-category="${e.category}" data-note="${escapeAttr(e.note || '')}">Edit</button>
                      <button type="button" class="danger" data-delete-expense="${e.id}">Delete</button>
                    </div>
                  </div>
                </td>
              </tr>
            `).join('')}
          </table>
        ` : `<p class="muted">No expenses logged yet.</p>`}
      </div>
    </div>
  `;

  document.getElementById('revenue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await post(`/api/projects/${id}/revenue`, { amount: Number(form.get('amount')), source: form.get('source') });
    renderProject(id); // refetch - the new total is already reflected, nothing else to update
  });

  document.getElementById('expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await post(`/api/projects/${id}/expenses`, { amount: Number(form.get('amount')), category: form.get('category') });
    renderProject(id);
  });

  document.getElementById('add-category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const name = form.get('name');
    if (!name || !name.trim()) return;
    await post('/api/expense-categories', { name: name.trim() });
    renderProject(id); // refetch - the new type now shows up in the dropdown above
  });

  // Edit/delete for each revenue entry
  document.querySelectorAll('[data-edit-revenue]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const amount = window.prompt('New amount', btn.dataset.amount);
      if (amount === null || amount === '') return;
      const source = window.prompt('Source (optional)', btn.dataset.source);
      await patch(`/api/revenue/${btn.dataset.editRevenue}`, { amount: Number(amount), source });
      renderProject(id);
    });
  });
  document.querySelectorAll('[data-delete-revenue]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm('Delete this revenue entry? This can\'t be undone.');
      if (!ok) return;
      await del(`/api/revenue/${btn.dataset.deleteRevenue}`);
      renderProject(id);
    });
  });

  // Edit/delete for each expense entry
  document.querySelectorAll('[data-edit-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const amount = window.prompt('New amount', btn.dataset.amount);
      if (amount === null || amount === '') return;
      await patch(`/api/expenses/${btn.dataset.editExpense}`, {
        amount: Number(amount),
        category: btn.dataset.category,
        note: btn.dataset.note,
      });
      renderProject(id);
    });
  });
  document.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm('Delete this expense entry? This can\'t be undone.');
      if (!ok) return;
      await del(`/api/expenses/${btn.dataset.deleteExpense}`);
      renderProject(id);
    });
  });

  // Rename/delete for expense categories
  const categorySelect = document.getElementById('category-manage-select');
  if (categorySelect) {
    document.getElementById('edit-category-btn').addEventListener('click', async () => {
      const opt = categorySelect.options[categorySelect.selectedIndex];
      if (!opt) return;
      const name = window.prompt('Rename expense type', opt.dataset.name);
      if (!name || name.trim() === '' || name === opt.dataset.name) return;
      await patch(`/api/expense-categories/${opt.value}`, { name: name.trim() });
      renderProject(id);
    });

    document.getElementById('delete-category-btn').addEventListener('click', async () => {
      const opt = categorySelect.options[categorySelect.selectedIndex];
      if (!opt) return;
      const ok = window.confirm(`Delete "${opt.dataset.name}"? This only works if no expenses currently use it.`);
      if (!ok) return;
      try {
        await del(`/api/expense-categories/${opt.value}`);
        renderProject(id);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  drawExpenseBarChart('project-expense-chart', data.costBreakdown);
}

// ---------- Vendors ----------

function vendorFieldsToForm(v) {
  // Populates the add/edit form from a vendor record (used when editing).
  return {
    name: v.name || '',
    service: v.service || '',
    projectId: v.projectId || v.project?.id || '',
    invoiceDate: v.invoiceDate ? new Date(v.invoiceDate).toISOString().slice(0, 10) : '',
    dueDate: v.dueDate ? new Date(v.dueDate).toISOString().slice(0, 10) : '',
    paymentAmount: v.paymentAmount ?? '',
    quarter: v.quarter || '',
    poc: v.poc || '',
    approvedBy: v.approvedBy || '',
    lastPaymentDate: v.lastPaymentDate ? new Date(v.lastPaymentDate).toISOString().slice(0, 10) : '',
    paymentTimeline: v.paymentTimeline || '',
    paid: !!v.paid,
    bankDetails: v.bankDetails || '',
  };
}

const VENDOR_OPTION_LABELS = { POC: 'POC', APPROVER: 'Approved by / PM', QUARTER: 'Quarter', PAYMENT_TIMELINE: 'Payment Timeline' };
const ADD_NEW_SENTINEL = '__add_new__';

// A <select> for one of the managed dropdown lists (POC/Approver/Quarter/
// Payment Timeline), falling back to the vendor's current value even if
// it's since been deleted from the list, so editing an old vendor never
// silently loses data. Always ends with a "+ Add new" option so a value can
// be added on the spot without leaving the form (wired up separately).
function vendorOptionSelect(name, type, currentValue, options) {
  const hasCurrentInList = !currentValue || options.some((o) => o.value === currentValue);
  return `
    <select name="${name}" data-option-select="${type}">
      <option value="">&mdash; none &mdash;</option>
      ${!hasCurrentInList ? `<option value="${escapeAttr(currentValue)}" selected>${escapeAttr(currentValue)} (removed from list)</option>` : ''}
      ${options.map((o) => `<option value="${escapeAttr(o.value)}" ${o.value === currentValue ? 'selected' : ''}>${escapeAttr(o.value)}</option>`).join('')}
      <option value="${ADD_NEW_SENTINEL}">+ Add new&hellip;</option>
    </select>
  `;
}

// Adding a new option from inside the select itself (not the Settings
// panel) - inserts the new <option> directly into this select so the rest
// of the form the person is mid-filling-in isn't disturbed by a re-render.
async function handleInlineAddOption(selectEl, type, previousValue) {
  const value = window.prompt(`Add new ${VENDOR_OPTION_LABELS[type].toLowerCase()}:`);
  if (!value || !value.trim()) { selectEl.value = previousValue; return; }
  try {
    const created = await post('/api/vendor-options', { type, value: value.trim() });
    const opt = document.createElement('option');
    opt.value = created.value;
    opt.textContent = created.value;
    selectEl.insertBefore(opt, selectEl.querySelector(`option[value="${ADD_NEW_SENTINEL}"]`));
    selectEl.value = created.value;
  } catch (err) {
    alert(err.message);
    selectEl.value = previousValue;
  }
}

function wireOptionSelects(root) {
  root.querySelectorAll('[data-option-select]').forEach((sel) => {
    let previousValue = sel.value;
    sel.addEventListener('change', () => {
      if (sel.value === ADD_NEW_SENTINEL) {
        handleInlineAddOption(sel, sel.dataset.optionSelect, previousValue);
      } else {
        previousValue = sel.value;
      }
    });
  });
}

async function renderVendors(editingId, settingsOpen) {
  const [{ vendors, summary }, projects, options] = await Promise.all([
    get('/api/vendors'),
    get('/api/all-projects'),
    get('/api/vendor-options'),
  ]);
  const pocOptions = options.filter((o) => o.type === 'POC');
  const approverOptions = options.filter((o) => o.type === 'APPROVER');
  const quarterOptions = options.filter((o) => o.type === 'QUARTER');
  const timelineOptions = options.filter((o) => o.type === 'PAYMENT_TIMELINE');

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '<span class="muted">-</span>');

  const editingVendor = editingId ? vendors.find((v) => v.id === editingId) : null;
  const f = vendorFieldsToForm(editingVendor || {});
  const invoiceViewUrl = (id) => `/api/vendors/${id}/invoice-file?token=${encodeURIComponent(getToken())}`;

  // One reusable block for managing an option list (POC/Approver/Quarter/
  // Payment Timeline) - rendered four times below inside the Settings panel.
  function optionManagerHtml(type, listOptions) {
    return `
      <div class="settings-col">
        <h3>${VENDOR_OPTION_LABELS[type]}</h3>
        <form data-option-form="${type}" class="entry-form entry-form--stacked">
          <input type="text" name="value" placeholder="Add ${VENDOR_OPTION_LABELS[type].toLowerCase()}" required />
          <button type="submit">Add</button>
        </form>
        ${listOptions.length ? `
          <ul class="option-list">
            ${listOptions.map((o) => `
              <li>
                <span>${escapeAttr(o.value)}</span>
                <div class="row-menu">
                  <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="option-${o.id}" title="Actions" aria-label="Actions">&#8942;</button>
                  <div class="row-menu-list" id="menu-option-${o.id}">
                    <button type="button" data-edit-option="${o.id}" data-value="${escapeAttr(o.value)}">Rename</button>
                    <button type="button" class="danger" data-delete-option="${o.id}" data-value="${escapeAttr(o.value)}">Delete</button>
                  </div>
                </div>
              </li>
            `).join('')}
          </ul>
        ` : `<p class="muted">Nothing here yet.</p>`}
      </div>
    `;
  }

  app.innerHTML = `
    <div class="eyebrow">Accounts payable</div>
    <div class="page-heading-row">
      <h1>Vendors</h1>
      <button type="button" class="icon-btn icon-only" id="vendor-settings-toggle" title="Settings" aria-label="Settings">&#9881;</button>
    </div>

    <div class="cards">
      ${card('Total owed', money(summary.totalOwed), '', 'expenses')}
      ${card('Overdue', String(summary.overdueCount), summary.overdueCount > 0 ? 'negative' : '', 'profit')}
      ${card('Due within 7 days', String(summary.dueSoonCount), '', 'count')}
    </div>

    ${settingsOpen ? `
      <div class="panel settings-panel">
        <h2>Vendor settings</h2>
        <p class="panel-sub">Manage the dropdown options below. Renaming updates every vendor already using that value; deleting one never breaks existing vendor rows - they just keep their current value.</p>
        <div class="settings-grid">
          ${optionManagerHtml('POC', pocOptions)}
          ${optionManagerHtml('APPROVER', approverOptions)}
          ${optionManagerHtml('QUARTER', quarterOptions)}
          ${optionManagerHtml('PAYMENT_TIMELINE', timelineOptions)}
        </div>
      </div>
    ` : ''}

    <div class="panel">
      <h2>${editingVendor ? `Edit vendor - ${escapeAttr(editingVendor.name)}` : 'Add vendor'}</h2>
      <form id="vendor-form" class="entry-form entry-form--stacked vendor-form-grid">
        <label>Project<select name="projectId">
          <option value="">No linked project (optional)</option>
          ${projects.map((p) => `<option value="${p.id}" ${f.projectId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select></label>
        <label>Vendor Name<input type="text" name="name" placeholder="Vendor name" required value="${escapeAttr(f.name)}" /></label>
        <label>Service<input type="text" name="service" placeholder="What was this for? e.g. Cloud hosting" value="${escapeAttr(f.service)}" /></label>
        <label>Invoice Date<input type="date" name="invoiceDate" value="${f.invoiceDate}" /></label>
        <label>Deadline<input type="date" name="dueDate" required value="${f.dueDate}" /></label>
        <label>Amount<input type="number" name="paymentAmount" placeholder="Amount" required step="0.01" value="${f.paymentAmount}" /></label>
        <label>Quarter${vendorOptionSelect('quarter', 'QUARTER', f.quarter, quarterOptions)}</label>
        <label>POC${vendorOptionSelect('poc', 'POC', f.poc, pocOptions)}</label>
        <label>Approved by / PM${vendorOptionSelect('approvedBy', 'APPROVER', f.approvedBy, approverOptions)}</label>
        <label>Last Payment Done<input type="date" name="lastPaymentDate" value="${f.lastPaymentDate}" /></label>
        <label>Payment Timeline${vendorOptionSelect('paymentTimeline', 'PAYMENT_TIMELINE', f.paymentTimeline, timelineOptions)}</label>
        <label class="vendor-bank-field">Bank Details<textarea name="bankDetails" rows="2" placeholder="Account no., IFSC/SWIFT, bank name">${escapeAttr(f.bankDetails)}</textarea></label>
        <label class="vendor-invoice-field">Invoice attachment (PDF or image)
          <input type="file" id="vendor-invoice-input" accept=".pdf,image/*" />
          <input type="hidden" name="invoiceFileToken" id="vendor-invoice-token" value="" />
          <div id="invoice-attach-status" class="muted invoice-attach-status">
            ${editingVendor && editingVendor.invoiceFile
              ? `Currently attached: <a href="${invoiceViewUrl(editingVendor.id)}" target="_blank" rel="noopener">view file</a>
                 <button type="button" class="icon-btn danger" id="remove-invoice-btn" data-vendor-id="${editingVendor.id}">Remove</button>`
              : 'No file attached yet - selecting one will try to auto-fill the fields above from it.'}
          </div>
        </label>
        <div class="vendor-form-actions">
          <button type="submit">${editingVendor ? 'Update vendor' : 'Add vendor'}</button>
          ${editingVendor ? `<button type="button" class="icon-btn" id="cancel-edit-vendor">Cancel</button>` : ''}
        </div>
      </form>
    </div>

    <div class="panel table-panel">
      <h2>All vendors</h2>
      ${vendors.length ? `
        <div class="table-scroll">
        <table>
          <tr>
            <th>S.NO</th><th>Project</th><th>Vendor Name</th><th>Service</th><th>Invoice Date</th><th>Deadline</th>
            <th>Overdue</th><th>Amount</th><th>Quarter</th><th>POC</th><th>Approved by/PM</th>
            <th>Last Payment Done</th><th>Payment Timeline</th>
            <th>Bank Details</th><th>Invoice</th><th></th>
          </tr>
          ${vendors.map((v, i) => `
            <tr class="${v.status === 'OVERDUE' ? 'vendor-row-overdue' : ''}">
              <td>${i + 1}</td>
              <td>${v.project ? v.project.name : '<span class="muted">-</span>'}</td>
              <td>${v.name}</td>
              <td>${v.service || '<span class="muted">-</span>'}</td>
              <td>${fmtDate(v.invoiceDate)}</td>
              <td>${fmtDate(v.dueDate)}</td>
              <td>${v.status === 'OVERDUE' ? '<span class="status-badge status-overdue">YES</span>' : '<span class="muted">No</span>'}</td>
              <td class="num">${money(v.paymentAmount)}</td>
              <td>${v.quarter || '<span class="muted">-</span>'}</td>
              <td>${v.poc || '<span class="muted">-</span>'}</td>
              <td>${v.approvedBy || '<span class="muted">-</span>'}</td>
              <td>${fmtDate(v.lastPaymentDate)}</td>
              <td>${v.paymentTimeline || '<span class="muted">-</span>'}</td>
              <td class="bank-details-cell">${v.bankDetails ? v.bankDetails.replace(/\n/g, '<br>') : '<span class="muted">-</span>'}</td>
              <td>${v.invoiceFile ? `<a href="${invoiceViewUrl(v.id)}" target="_blank" rel="noopener">View</a>` : '<span class="muted">-</span>'}</td>
              <td class="num">
                <div class="row-menu">
                  <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="${v.id}" title="Actions" aria-label="Actions">&#8942;</button>
                  <div class="row-menu-list" id="menu-${v.id}">
                    <button type="button" data-toggle-paid="${v.id}" data-currently-paid="${v.paid}">${v.paid ? 'Mark Pending' : 'Mark Paid'}</button>
                    <button type="button" data-edit-vendor="${v.id}">Edit</button>
                    <button type="button" class="danger" data-delete-vendor="${v.id}" data-name="${escapeAttr(v.name)}">Delete</button>
                  </div>
                </div>
              </td>
            </tr>
          `).join('')}
        </table>
        </div>
      ` : `<p class="muted">No vendors yet - add one above.</p>`}
    </div>
  `;

  document.getElementById('vendor-settings-toggle').addEventListener('click', () => renderVendors(editingId, !settingsOpen));

  wireOptionSelects(document.getElementById('vendor-form'));

  // Adding/renaming/deleting an option list entry (POC / Approver / Quarter / Payment Timeline)
  document.querySelectorAll('[data-option-form]').forEach((formEl) => {
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = formEl.dataset.optionForm;
      const value = new FormData(formEl).get('value');
      try {
        await post('/api/vendor-options', { type, value });
        renderVendors(editingId, true);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  document.querySelectorAll('[data-edit-option]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const value = window.prompt('Rename to:', btn.dataset.value);
      if (!value || !value.trim() || value.trim() === btn.dataset.value) return;
      try {
        await patch(`/api/vendor-options/${btn.dataset.editOption}`, { value: value.trim() });
        renderVendors(editingId, true);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  document.querySelectorAll('[data-delete-option]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm(`Delete "${btn.dataset.value}" from this list? Vendors already using it keep it, but you won't be able to pick it for new ones.`);
      if (!ok) return;
      await del(`/api/vendor-options/${btn.dataset.deleteOption}`);
      renderVendors(editingId, true);
    });
  });

  // Selecting a file immediately uploads it for text extraction (before the
  // vendor itself is saved) and, if anything useful was read out of it,
  // fills in the empty fields above - existing typed values are left alone.
  document.getElementById('vendor-invoice-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const statusEl = document.getElementById('invoice-attach-status');
    if (!file) return;
    statusEl.textContent = `Reading ${file.name} - extracting details...`;
    try {
      const result = await uploadFile('/api/invoice-extract', file, 'invoice');
      document.getElementById('vendor-invoice-token').value = result.fileToken;

      const form = document.getElementById('vendor-form');
      const g = result.guessed || {};
      const nameField = form.elements.namedItem('name');
      const serviceField = form.elements.namedItem('service');
      const amountField = form.elements.namedItem('paymentAmount');
      const invoiceDateField = form.elements.namedItem('invoiceDate');
      const dueDateField = form.elements.namedItem('dueDate');
      const bankDetailsField = form.elements.namedItem('bankDetails');
      let filledAny = false;
      if (g.vendorName && !nameField.value.trim()) { nameField.value = g.vendorName; filledAny = true; }
      if (g.service && !serviceField.value.trim()) { serviceField.value = g.service; filledAny = true; }
      if (g.amount && !amountField.value) { amountField.value = g.amount; filledAny = true; }
      if (g.invoiceDate && !invoiceDateField.value) { invoiceDateField.value = g.invoiceDate; filledAny = true; }
      if (g.dueDate && !dueDateField.value) { dueDateField.value = g.dueDate; filledAny = true; }
      if (g.bankDetails && !bankDetailsField.value.trim()) { bankDetailsField.value = g.bankDetails; filledAny = true; }

      if (result.extractionError) {
        statusEl.textContent = `${file.name} attached. Couldn't auto-read it (${result.extractionError}) - fields left as-is.`;
      } else if (filledAny) {
        statusEl.textContent = `${file.name} attached. Auto-filled from the invoice - please double-check before saving.`;
      } else {
        statusEl.textContent = `${file.name} attached. Nothing recognizable to auto-fill - fields left as-is.`;
      }
    } catch (err) {
      statusEl.textContent = `Couldn't attach ${file.name}: ${err.message}`;
    }
  });

  document.getElementById('remove-invoice-btn')?.addEventListener('click', async (e) => {
    const id = e.target.dataset.vendorId;
    await del(`/api/vendors/${id}/invoice-file`);
    renderVendors(id);
  });

  document.getElementById('vendor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      name: form.get('name'),
      service: form.get('service') || null,
      paymentAmount: Number(form.get('paymentAmount')),
      dueDate: form.get('dueDate'),
      projectId: form.get('projectId') || null,
      invoiceDate: form.get('invoiceDate') || null,
      quarter: form.get('quarter') || null,
      poc: form.get('poc') || null,
      approvedBy: form.get('approvedBy') || null,
      lastPaymentDate: form.get('lastPaymentDate') || null,
      paymentTimeline: form.get('paymentTimeline') || null,
      bankDetails: form.get('bankDetails') || null,
      invoiceFileToken: form.get('invoiceFileToken') || null,
    };
    if (editingVendor) {
      await patch(`/api/vendors/${editingVendor.id}`, payload);
    } else {
      await post('/api/vendors', payload);
    }
    renderVendors();
  });

  const cancelBtn = document.getElementById('cancel-edit-vendor');
  if (cancelBtn) cancelBtn.addEventListener('click', () => renderVendors());

  // "Mark Paid" / "Mark Pending" menu action - flips the underlying paid
  // flag immediately, no separate save step.
  document.querySelectorAll('[data-toggle-paid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const currentlyPaid = btn.dataset.currentlyPaid === 'true';
      await patch(`/api/vendors/${btn.dataset.togglePaid}`, { paid: !currentlyPaid });
      renderVendors(editingId, settingsOpen);
    });
  });

  document.querySelectorAll('[data-edit-vendor]').forEach((btn) => {
    btn.addEventListener('click', () => renderVendors(btn.dataset.editVendor));
  });

  document.querySelectorAll('[data-delete-vendor]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm(`Delete "${btn.dataset.name}"? This can't be undone.`);
      if (!ok) return;
      await del(`/api/vendors/${btn.dataset.deleteVendor}`);
      renderVendors();
    });
  });
}

// ---------- Users ----------

const ROLE_OPTIONS = ['EXEC', 'FINANCE', 'VERTICAL_HEAD', 'PROJECT_MANAGER'];

async function renderUsers() {
  if (!canManageUsers()) {
    app.innerHTML = `<p class="negative">Only EXEC users can manage logins.</p>`;
    return;
  }

  const [users, me] = await Promise.all([get('/api/users'), get('/api/auth/me')]);

  app.innerHTML = `
    <div class="eyebrow">Access control</div>
    <h1>Users</h1>

    <div class="panel">
      <h2>Add user</h2>
      <form id="user-form" class="entry-form">
        <input type="text" name="name" placeholder="Full name" required />
        <input type="email" name="email" placeholder="Email" required />
        <input type="password" name="password" placeholder="Password (min. 6 chars)" required minlength="6" />
        <select name="role">
          ${ROLE_OPTIONS.map((r) => `<option value="${r}">${r}</option>`).join('')}
        </select>
        <button type="submit">Add user</button>
      </form>
    </div>

    <div class="panel table-panel">
      <h2>All users</h2>
      <table>
        <tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>
        ${users.map((u) => `
          <tr>
            <td>${escapeAttr(u.name)}</td>
            <td>${escapeAttr(u.email)}</td>
            <td><span class="status-badge status-pending">${u.role}</span></td>
            <td class="num">
              <div class="row-menu">
                <button type="button" class="icon-btn row-menu-btn" data-menu-toggle="user-${u.id}" title="Actions" aria-label="Actions">&#8942;</button>
                <div class="row-menu-list" id="menu-user-${u.id}">
                  <button type="button" data-edit-user="${u.id}" data-name="${escapeAttr(u.name)}" data-role="${u.role}">Edit</button>
                  ${u.id !== me.id ? `<button type="button" class="danger" data-delete-user="${u.id}" data-name="${escapeAttr(u.name)}">Delete</button>` : ''}
                </div>
              </div>
            </td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;

  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await post('/api/users', {
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      role: form.get('role'),
    });
    renderUsers();
  });

  document.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = window.prompt('Full name', btn.dataset.name);
      if (!name || !name.trim()) return;
      const role = window.prompt(`Role (one of: ${ROLE_OPTIONS.join(', ')})`, btn.dataset.role);
      if (!role || !ROLE_OPTIONS.includes(role.trim().toUpperCase())) {
        if (role !== null) alert('Not a valid role - no changes saved.');
        return;
      }
      const password = window.prompt('New password (leave blank to keep the current one)', '');
      await patch(`/api/users/${btn.dataset.editUser}`, {
        name: name.trim(),
        role: role.trim().toUpperCase(),
        password: password && password.trim() ? password.trim() : undefined,
      });
      renderUsers();
    });
  });

  document.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.confirm(`Delete "${btn.dataset.name}"? They will no longer be able to log in. This can't be undone.`);
      if (!ok) return;
      await del(`/api/users/${btn.dataset.deleteUser}`);
      renderUsers();
    });
  });
}

// Single delegated listener for the row-action "kebab" menus (e.g. the
// Edit/Delete menu on each vendor row) - attached once here rather than
// inside each render function, so it isn't re-registered (and stacked up)
// on every re-render. Menus themselves are found fresh at click time, so
// this keeps working no matter how many times the table underneath it
// gets redrawn.
//
// The menu itself is `position: fixed` (see .row-menu-list in style.css),
// positioned in JS from the toggle button's on-screen location rather than
// via CSS anchored to the row. That's what lets it escape any scrolling
// table/panel that would otherwise clip it - which is exactly what was
// happening to "Delete" on rows near the bottom of a scrolled table.
function positionRowMenu(menu, toggleBtn) {
  const btnRect = toggleBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 6;

  let left = btnRect.right - menuRect.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));

  let top = btnRect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = btnRect.top - menuRect.height - 4; // not enough room below - open upward instead
  }
  top = Math.max(margin, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeAllRowMenus() {
  document.querySelectorAll('.row-menu-list.open').forEach((m) => m.classList.remove('open'));
}

document.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-menu-toggle]');
  if (toggleBtn) {
    const menu = document.getElementById(`menu-${toggleBtn.dataset.menuToggle}`);
    const wasOpen = menu.classList.contains('open');
    closeAllRowMenus();
    if (!wasOpen) {
      menu.classList.add('open');
      positionRowMenu(menu, toggleBtn);
    }
  } else if (!e.target.closest('.row-menu-list')) {
    closeAllRowMenus();
  }
});

// The menu is positioned relative to the viewport at the moment it opens;
// if the page (or a scrollable table inside it) scrolls afterward, close it
// rather than leaving it visually detached from the row it belongs to.
window.addEventListener('scroll', closeAllRowMenus, { capture: true, passive: true });
window.addEventListener('resize', closeAllRowMenus);

render();