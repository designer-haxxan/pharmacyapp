// Application bootstrap: service worker, database, authentication gate, navigation and routing.
import { CONFIG } from './config.js';
import { applyTheme, getSettings } from './core/settings.js';
import * as UI from './core/ui.js';
import { esc } from './core/utils.js';
import { t, getLang, setLang, applyLang, translateDom, isUrdu, startAutoTranslate } from './core/i18n.js';
import { daysLeft } from './core/pharma.js';
import { openDB } from './db/idb.js';
import * as Auth from './services/auth.js';
import * as Catalog from './services/catalog.js';

const $ = window.jQuery;

// Route table: name → [loader, title, permission|null, icon, menu section]
const ROUTES = {
  dashboard: [() => import('./modules/dashboard.js'), 'Home', null, 'house-heart', 'Daily work'],
  pos: [() => import('./modules/pos.js'), 'New Sale', 'sale.create', 'cart-plus', 'Daily work'],
  sales: [() => import('./modules/documents.js'), 'Sales', null, 'receipt', 'Daily work'],
  purchase: [() => import('./modules/pos.js'), 'New Purchase', 'purchase.manage', null, null],
  purchases: [() => import('./modules/documents.js'), 'Purchases', 'purchase.manage', 'bag-check', 'Daily work'],
  returns: [() => import('./modules/documents.js'), 'Returns', null, 'arrow-return-left', 'Daily work'],
  products: [() => import('./modules/products.js'), 'Medicines', null, 'capsule', 'Medicines'],
  stock: [() => import('./modules/stock.js'), 'Stock', null, 'boxes', 'Medicines'],
  expiry: [() => import('./modules/expiry.js'), 'Expiry', null, 'calendar2-x', 'Medicines'],
  demand: [() => import('./modules/demand.js'), 'Order list', 'demand.manage', 'clipboard2-pulse', 'Medicines'],
  trace: [() => import('./modules/trace.js'), 'Batch trace', null, 'binoculars', 'Medicines'],
  rx: [() => import('./modules/rx.js'), 'Rx register', 'reports.view', 'prescription2', 'Medicines'],
  customers: [() => import('./modules/parties.js'), 'Customers', null, 'people', 'Parties'],
  suppliers: [() => import('./modules/parties.js'), 'Suppliers', 'purchase.manage', 'truck', 'Parties'],
  vouchers: [() => import('./modules/vouchers.js'), 'Cash Book & Payments', 'voucher.create', 'cash-coin', 'Accounts'],
  accounts: [() => import('./modules/accounts.js'), 'Accounts', 'account.manage', 'bank', 'Accounts'],
  reports: [() => import('./reports/reports.js'), 'Reports', 'reports.view', 'bar-chart-line', 'Accounts'],
  backup: [() => import('./modules/backup.js'), 'Backup & Restore', 'backup.export', 'cloud-arrow-down', 'Administration'],
  settings: [() => import('./modules/settings.js'), 'Settings', null, 'gear', 'Administration'],
};
const FOCUS_ROUTES = new Set(['pos', 'purchase']);

let currentModule = null;
let routeToken = 0;
let deferredInstall = null;

function showView(name) {
  $('#splash').addClass('d-none');
  $('#view-login').toggleClass('d-none', name !== 'login');
  $('#view-app').toggleClass('d-none', name !== 'app');
}

function fatal(msg) {
  $('#splash-error').text(msg);
  $('#splash .splash-ecg').addClass('d-none');
}

// ---------- Service worker & install ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  // Local development: no offline cache (it would serve stale files). Add ?sw to the URL to test offline mode.
  if (Auth.demoAvailable() && !location.search.includes('sw')) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    caches.keys().then((ks) => ks.filter((k) => k.startsWith(CONFIG.APP_ID + '-')).forEach((k) => caches.delete(k)));
    return;
  }
  // New versions install and activate on their own (see service-worker.js); check whenever the app is opened.
  navigator.serviceWorker.register('service-worker.js').then((reg) => {
    const check = () => {
      if (!navigator.onLine) return;
      reg.update().catch(() => {});
      // Other apps on this origin can wipe our offline cache; ask the worker to rebuild it if needed.
      (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'ENSURE_CACHE' });
    };
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 60 * 60 * 1000);
  }).catch((e) => console.warn('Service worker registration failed:', e));
  // Reload when an update replaces an existing worker, so the page never mixes files from two versions.
  let controlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled && !reloading) { reloading = true; location.reload(); }
    controlled = true;
  });
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('#install-btn').removeClass('d-none'); });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('#install-btn').addClass('d-none'); UI.toast(t('App installed')); });
export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null; $('#install-btn').addClass('d-none');
  return true;
}
export const canInstall = () => !!deferredInstall;

// ---------- Connection badge ----------
function renderConn(status) {
  const map = { online: ['wifi', 'Online'], offline: ['wifi-off', 'Offline'] };
  const [icon, label] = map[status] || map.offline;
  $('#conn-badge').attr('class', `badge rounded-pill conn-${status}`).html(`<i class="bi bi-${icon}"></i> <span>${t(label)}</span>`);
  $('#login-conn').html(navigator.onLine ? `<i class="bi bi-wifi text-success"></i> ${t('Online')}` : `<i class="bi bi-wifi-off text-danger"></i> ${t('Offline — connect to the internet to sign in')}`);
}
window.addEventListener('online', () => renderConn('online'));
window.addEventListener('offline', () => renderConn('offline'));

// ---------- Expiry alert badge (batches expired or expiring within 30 days) ----------
function updateExpiryBadge() {
  if (!Auth.user()) return;
  const n = Catalog.allBatches().filter((b) => daysLeft(b.expiry) <= 30).length;
  $('#nav-expiry-badge').toggleClass('d-none', !n).text(n > 99 ? '99+' : n);
  $('.nav-menu [data-route="expiry"] .nav-count').remove();
  if (n) $('.nav-menu [data-route="expiry"]').append(`<span class="nav-count">${n > 99 ? '99+' : n}</span>`);
}

// ---------- Navigation ----------
function buildMenu() {
  let html = ''; let section = '';
  for (const [name, [, title, perm, icon, sec]] of Object.entries(ROUTES)) {
    if (!sec || (perm && !Auth.can(perm))) continue;
    if (sec !== section) { section = sec; html += `<div class="nav-section">${esc(t(sec))}</div>`; }
    html += `<a class="nav-link" href="#/${name}" data-route="${name}"><i class="bi bi-${icon}"></i>${esc(t(title))}</a>`;
  }
  $('.nav-menu').html(html);
  const u = Auth.user();
  $('#user-name').text(u.name);
  $('#user-role').text(t(Auth.ROLES[u.role] || u.role));
  $('#user-avatar').text(UI.initials(u.name));
  const b = getSettings().business;
  $('#brand-name').text((isUrdu() && b.nameUr) || b.name || (isUrdu() ? CONFIG.APP_NAME_UR : CONFIG.APP_NAME));
  $('#bottom-nav [data-route="pos"]').toggleClass('d-none', !Auth.can('sale.create'));
  $(`.nav-menu [data-route="${currentRouteName()}"]`).addClass('active');
  updateExpiryBadge();
}

const currentRouteName = () => {
  const n = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  return ROUTES[n] ? n : 'dashboard';
};

async function route() {
  if (!Auth.user()) return;
  if (checkExpiry()) return;
  const token = ++routeToken;
  const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/').map(decodeURIComponent);
  const name = ROUTES[parts[0]] ? parts[0] : 'dashboard';
  const [loader, title, perm] = ROUTES[name];
  try { currentModule?.destroy?.(); } catch (e) { console.warn(e); }
  currentModule = null;
  bootstrap.Offcanvas.getInstance('#menu-offcanvas')?.hide();
  $('.nav-menu .nav-link, #bottom-nav a').removeClass('active');
  $(`.nav-menu [data-route="${name}"], #bottom-nav [data-route="${name}"]`).addClass('active');
  $('body').toggleClass('focus-mode', FOCUS_ROUTES.has(name));
  $('#topbar-title').text(t(title));
  const $c = $('#content').off();
  if (perm && !Auth.can(perm)) { $c.html(UI.emptyState(t('You do not have permission to open this page.'), 'shield-lock')); return; }
  $c.html(UI.spinner());
  try {
    const mod = (await loader()).default;
    if (token !== routeToken) return;
    currentModule = mod;
    window.scrollTo(0, 0);
    $c.removeClass('page-enter');
    await mod.render($c[0], { route: name, params: parts.slice(1), setTitle: (x) => $('#topbar-title').text(x) });
    if (token === routeToken) { void $c[0].offsetWidth; $c.addClass('page-enter'); }
  } catch (e) {
    console.error(e);
    if (token === routeToken) $c.html(UI.errorState(e));
  }
}

// ---------- Language ----------
function refreshLangUI() {
  applyLang();
  translateDom(document);
  $('.lang-label').text(isUrdu() ? 'English' : 'اردو');
  renderConn(navigator.onLine ? 'online' : 'offline');
  const hint = isUrdu() ? 'Demo (صرف اس کمپیوٹر پر)' : 'Demo (this computer only)';
  $('#demo-btn').html(`<i class="bi bi-flask me-1"></i>${hint}`);
  document.title = isUrdu() ? CONFIG.APP_NAME_UR : CONFIG.APP_NAME;
}
// Switching language reloads the page (the draft cart and everything else is kept) so every label is rebuilt cleanly.
$(document).on('click', '[data-lang-toggle]', () => {
  setLang(getLang() === 'ur' ? 'en' : 'ur');
  location.reload();
});

// ---------- Auth gate ----------
async function startApp() {
  await Catalog.load();
  buildMenu();
  showView('app');
  refreshLangUI();
  clearInterval(expiryTimer);
  expiryTimer = setInterval(checkExpiry, 60000);
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist().catch(() => {}); });
  route();
}

async function doLogout(forced = false, reason = '') {
  if (!forced && !await UI.confirmDialog(t('Log out of this device? Your data stays on this device, but signing in again requires an internet connection.'), { okLabel: t('Log out'), okClass: 'btn-danger' })) return;
  clearInterval(expiryTimer);
  try { currentModule?.destroy?.(); } catch { /* ignore */ }
  currentModule = null;
  Auth.logout();
  $('#content').empty();
  showLogin(reason);
}

// Sessions are valid until expiresAt (set by the server); after that an online sign-in is required.
let expiryTimer = null;
function checkExpiry() {
  if (!Auth.sessionExpired()) return false;
  UI.toast(t('Your session has expired. Please sign in again.'), 'warning', 6000);
  doLogout(true, t('Your session has expired. Connect to the internet and sign in again.'));
  return true;
}

function showLogin(reason = '') {
  showView('login');
  refreshLangUI();
  $('#demo-btn').toggleClass('d-none', !Auth.demoAvailable());
  const notices = [];
  if (reason) notices.push(esc(reason));
  $('#login-notice').toggleClass('d-none', !notices.length).html(notices.join('<br>'));
  setTimeout(() => $('#login-username').trigger('focus'), 50);
}

$('#login-form').on('submit', async (e) => {
  e.preventDefault();
  const $btn = $('#login-btn').prop('disabled', true).html(`<span class="spinner-border spinner-border-sm"></span><span>${t('Signing in…')}</span>`);
  $('#login-error').addClass('d-none');
  try {
    await Auth.login($('#login-username').val(), $('#login-password').val());
    $('#login-password').val('');
    await startApp();
  } catch (err) {
    $('#login-error').text(err.message || String(err)).removeClass('d-none');
    $('.auth-card').removeClass('shake'); void $('.auth-card')[0].offsetWidth; $('.auth-card').addClass('shake');
  } finally { $btn.prop('disabled', false).html(`<span>${t('Sign in')}</span><i class="bi bi-arrow-right"></i>`); }
});
$('#demo-btn').on('click', async () => {
  try { Auth.demoLogin(); await startApp(); } catch (err) { $('#login-error').text(err.message || String(err)).removeClass('d-none'); }
});
$('#toggle-pw').on('click', () => {
  const $i = $('#login-password'); const show = $i.attr('type') === 'password';
  $i.attr('type', show ? 'text' : 'password');
  $('#toggle-pw i').attr('class', show ? 'bi bi-eye-slash' : 'bi bi-eye');
});
$('#logout-btn').on('click', () => doLogout(false));
$('#install-btn').on('click', promptInstall);
window.addEventListener('hashchange', route);
document.addEventListener('settings:changed', () => { applyTheme(); if (Auth.user()) { const b = getSettings().business; $('#brand-name').text((isUrdu() && b.nameUr) || b.name || CONFIG.APP_NAME); } });
document.addEventListener('auth:changed', () => { if (Auth.user()) buildMenu(); });
document.addEventListener('data:changed', updateExpiryBadge);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ---------- Boot ----------
(async function boot() {
  applyTheme();
  applyLang();
  startAutoTranslate();
  registerSW();
  if (!window.jQuery || !window.bootstrap) return fatal(t('Required libraries failed to load. Connect to the internet once so the app can be cached for offline use.'));
  try { await openDB(); } catch (e) { return fatal('Could not open the local database: ' + (e.message || e)); }
  const { user, reason } = Auth.restoreSession();
  if (user) {
    try { await startApp(); } catch (e) { console.error(e); fatal(e.message || String(e)); }
  } else showLogin(reason);
})();
