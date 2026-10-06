// Home screen: today's figures, pharmacy alerts (expiry, low stock, order list) and big action tiles.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtTime, fmtDate, today, localDate, round2, debounce } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref, getSettings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { UR } from '../core/ur.js';
import { isUrdu } from '../core/i18n.js';
import { daysLeft, isLowStock, expiryChip, stockText, medTitle } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';

const $ = window.jQuery;

export async function todayFigures(date = today()) {
  const r = IDBKeyRange.only(date);
  const [sales, purchases, sret, pret, vouchers, entries, accounts] = await idb.read(['sales', 'purchases', 'saleReturns', 'purchaseReturns', 'vouchers', 'entries', 'accounts'], (tx) => Promise.all([
    tx.getAllByIndex('sales', 'date', r), tx.getAllByIndex('purchases', 'date', r), tx.getAllByIndex('saleReturns', 'date', r),
    tx.getAllByIndex('purchaseReturns', 'date', r), tx.getAllByIndex('vouchers', 'date', r), tx.getAllByIndex('entries', 'date', r), tx.getAll('accounts'),
  ]));
  const live = (x) => x.filter((d) => d.status !== 'void');
  const cashIds = new Set(accounts.filter((a) => ['cash', 'bank'].includes(a.type)).map((a) => a.id));
  const cashEntries = entries.filter((e) => cashIds.has(e.accountId) && e.refType !== 'opening' && e.refType !== 'transfer');
  const s = live(sales); const p = live(purchases); const sr = live(sret);
  const netSales = s.reduce((a, d) => a + d.total - (d.tax || 0), 0) - sr.reduce((a, d) => a + d.total - (d.tax || 0), 0);
  const cogs = s.reduce((a, d) => a + (d.costTotal || 0), 0) - sr.reduce((a, d) => a + d.items.reduce((x, i) => x + (i.cost || 0) * (i.baseQty ?? i.qty), 0), 0);
  return {
    sales: round2(s.reduce((a, d) => a + d.total, 0)), salesCount: s.length,
    profit: round2(netSales - cogs),
    purchases: round2(p.reduce((a, d) => a + d.total, 0)), purchasesCount: p.length,
    saleReturns: round2(sr.reduce((a, d) => a + d.total, 0)),
    purchaseReturns: round2(live(pret).reduce((a, d) => a + d.total, 0)),
    cashIn: round2(cashEntries.reduce((a, e) => a + e.debit, 0)),
    cashOut: round2(cashEntries.reduce((a, e) => a + e.credit, 0)),
    txCount: s.length + p.length + sr.length + live(pret).length + live(vouchers).length,
    recent: s.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
    cashIds,
  };
}

// Sales per day for the last 7 days + top medicines by amount (from sale lines).
async function weekFigures() {
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localDate(d)); }
  const range = IDBKeyRange.bound(days[0], days[6]);
  const [sales, items] = await idb.read(['sales', 'saleItems'], (tx) => Promise.all([tx.getAllByIndex('sales', 'date', range), tx.getAllByIndex('saleItems', 'date', range)]));
  const byDay = Object.fromEntries(days.map((d) => [d, { date: d, total: 0, count: 0 }]));
  for (const s of sales) if (s.status !== 'void' && byDay[s.date]) { byDay[s.date].total += s.total; byDay[s.date].count++; }
  const prod = new Map();
  for (const i of items) { const x = prod.get(i.productId) || { name: i.name, amount: 0 }; x.amount += i.amount; prod.set(i.productId, x); }
  return { days: days.map((d) => ({ ...byDay[d], total: round2(byDay[d].total) })), top: [...prod.values()].sort((a, b) => b.amount - a.amount).slice(0, 5) };
}

const compact = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// Single-series bar chart drawn at the container's real width (so text stays crisp). Hover/tap shows a tooltip.
function drawWeekChart(box, days) {
  const W = Math.max(280, box.clientWidth); const H = 190;
  const m = { t: 22, r: 8, b: 26, l: 40 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const max = niceMax(Math.max(...days.map((d) => d.total)));
  const band = iw / days.length; const bw = Math.min(36, band * 0.56);
  const y = (v) => m.t + ih - (v / max) * ih;
  const peak = days.reduce((a, d, i) => (d.total > days[a].total ? i : a), 0);
  const ticks = [0, max / 2, max];
  const barPath = (x, top, w, h) => {
    if (h <= 0) return '';
    const r = Math.min(4, h, w / 2);
    return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(t('Sales — last 7 days'))}"><g class="grid">`;
  for (const tk of ticks) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(tk)}" y2="${y(tk)}"/>`;
  svg += '</g><g class="axis">';
  for (const tk of ticks) svg += `<text x="${m.l - 8}" y="${y(tk) + 4}" text-anchor="end">${compact(tk)}</text>`;
  days.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const label = i === days.length - 1 ? t('Today') : new Date(d.date + 'T00:00:00').toLocaleDateString(isUrdu() ? 'ur-PK' : undefined, { weekday: 'short' });
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" ${i === days.length - 1 ? 'font-weight="700"' : ''}>${esc(label)}</text>`;
  });
  svg += '</g>';
  days.forEach((d, i) => {
    const x = m.l + band * i + (band - bw) / 2; const top = y(d.total); const h = m.t + ih - top;
    svg += `<path class="bar" d="${barPath(x, top, bw, h)}" style="animation-delay:${i * 0.05}s"/>`;
    if ((i === peak || i === days.length - 1) && d.total > 0) svg += `<text class="val" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${compact(d.total)}</text>`;
    svg += `<rect class="bar-hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg><div class="viz-tip"></div>';
  box.innerHTML = svg;
  const tip = box.querySelector('.viz-tip');
  const show = (el) => {
    const d = days[+el.dataset.i];
    tip.innerHTML = `<b>${esc(fmtDate(d.date))}</b><br>${esc(cur())} ${fmtNum(d.total)} · ${d.count} ${esc(t('invoices'))}`;
    tip.style.left = `${(+el.getAttribute('x') + band / 2)}px`;
    tip.style.top = `${Math.max(14, y(d.total))}px`;
    tip.classList.add('show');
  };
  box.querySelectorAll('.bar-hit').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('click', () => show(el));
    el.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

// Label shown on a tile: main language big, the other language small (so both readers understand).
const dual = (en) => (isUrdu() ? `<span class="t">${esc(UR[en] || en)}</span><span class="s" data-no-i18n>${esc(en)}</span>` : `<span class="t">${esc(en)}</span>${UR[en] ? `<span class="s ur-line">${esc(UR[en])}</span>` : ''}`);

const ring = (count, total, color) => {
  const frac = total ? Math.max(count ? 0.12 : 0, Math.min(1, count / total)) : 0;
  return `<div class="ring-wrap"><svg viewBox="0 0 54 54"><circle class="ring-bg" cx="27" cy="27" r="22"/><circle class="ring-fg" cx="27" cy="27" r="22" style="--off:${(138.2 * (1 - frac)).toFixed(1)};--ring:${color}"/></svg><span class="n">${count}</span></div>`;
};

export default {
  async render(el) {
    this.destroy();
    const $el = $(el);
    const u = Auth.user();
    const [f, bal, wk, demands] = await Promise.all([todayFigures(), Posting.allBalances(), weekFigures(), idb.getAllByIndex('demands', 'status', 'open')]);
    let rec = 0; let pay = 0; let cash = 0;
    for (const [id, b] of bal) {
      if (id.startsWith('C:') && b.balance > 0) rec += b.balance;
      if (id.startsWith('S:') && b.balance < 0) pay -= b.balance;
      if (f.cashIds.has(id)) cash += b.balance;
    }
    const prods = Catalog.allProducts().filter((p) => p.active);
    const tracked = prods.filter((p) => p.trackStock !== false);
    const batches = Catalog.allBatches();
    const withDays = batches.map((b) => ({ b, p: Catalog.product(b.productId), d: daysLeft(b.expiry) })).filter((x) => x.p);
    const expired = withDays.filter((x) => x.d < 0);
    const soon = withDays.filter((x) => x.d >= 0 && x.d <= 30);
    const soon90 = withDays.filter((x) => x.d > 30 && x.d <= 90);
    const val = (list) => round2(list.reduce((s, x) => s + x.b.qty * (x.b.cost || 0), 0));
    const low = tracked.filter((p) => isLowStock(p));
    const stockValue = tracked.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePrice || 0) / (p.packSize || 1), 0);
    const nearList = withDays.filter((x) => x.d <= 90).sort((a, b) => a.d - b.d).slice(0, 6);
    const lastBackup = pref.get('lastBackupAt');
    const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : null;
    const hour = new Date().getHours();
    const greet = isUrdu() ? 'السلام علیکم' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const M = (n) => `data-count="${round2(n)}" data-money="1"`;
    const biz = getSettings().business;
    const canProfit = Auth.can('reports.profit');

    const bigTile = (href, icon, cls, en, extra = '', perm = null) => (perm && !Auth.can(perm) ? '' : `<div class="col-6 col-md-3"><a class="big-tile tile-${cls}" href="${href}">${extra}<span class="bi-wrap"><i class="bi bi-${icon}"></i></span>${dual(en)}</a></div>`);
    const alertCard = (href, count, total, color, label, sub, bad) => `<div class="col-12 col-sm-6 col-lg-3"><a class="alert-card ${bad ? 'is-bad' : ''}" href="${href}">${ring(count, total, color)}<div class="min-w-0"><div class="l">${label}</div><div class="s">${sub}</div></div></a></div>`;
    const tile = (href, icon, tint, title, sub, perm) => (perm && !Auth.can(perm) ? '' : `<div class="col-6 col-md-4 col-xl-3">
      <a class="hub-tile" href="${href}"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div>
      <div class="min-w-0"><div class="t">${title}</div><div class="s">${sub}</div></div></a></div>`);
    const kpi = (icon, tint, label, valueAttr, href) => `<div class="col-6 col-lg-3"><${href ? `a href="${href}"` : 'div'} class="stat-card card-body d-block text-decoration-none p-3 h-100">
      <div class="kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div><div class="min-w-0"><div class="l">${label}</div><div class="v money" ${valueAttr}>0</div></div></div></${href ? 'a' : 'div'}></div>`;

    $el.html(`
      <div class="hero-card">
        <svg class="hero-ecg" viewBox="0 0 600 64" preserveAspectRatio="none" aria-hidden="true"><path d="M0 40 H180 L196 40 L210 14 L228 56 L246 24 L258 40 H600"/></svg>
        <div class="d-flex justify-content-between align-items-start gap-2 mb-3">
          <div><div class="hello">${greet}, ${esc(u.name.split(' ')[0])}</div><div class="date">${esc(biz.name)} · ${new Date().toLocaleDateString(isUrdu() ? 'ur-PK' : undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
          <span class="pill"><i class="bi bi-${navigator.onLine ? 'cloud-check' : 'wifi-off'}"></i>${navigator.onLine ? t('Online') : t('Offline')}</span>
        </div>
        <div class="lbl">${t("Today's sales")}</div>
        <div class="big money" ${M(f.sales)}>0</div>
        <div class="d-flex flex-wrap gap-2 mt-2 mb-3">
          <span class="pill"><i class="bi bi-receipt"></i>${f.salesCount} ${t('invoices')}</span>
          ${canProfit ? `<span class="pill"><i class="bi bi-graph-up-arrow"></i>${t('Profit')} ${esc(cur())} ${fmtNum(f.profit)}</span>` : ''}
          <span class="pill"><i class="bi bi-arrow-down-circle"></i>${t('In')} ${esc(cur())} ${fmtNum(f.cashIn)}</span>
          <span class="pill"><i class="bi bi-arrow-up-circle"></i>${t('Out')} ${esc(cur())} ${fmtNum(f.cashOut)}</span>
        </div>
        <div class="d-flex flex-wrap gap-2">
          ${Auth.can('sale.create') ? `<a class="btn hero-cta" href="#/pos"><i class="bi bi-cart-plus me-1"></i>${t('New Sale')}</a>` : ''}
          ${Auth.can('purchase.manage') ? `<a class="btn btn-outline-light" href="#/purchase/new"><i class="bi bi-bag-plus me-1"></i>${t('New Purchase')}</a>` : ''}
        </div>
      </div>
      ${!navigator.onLine ? `<div class="alert alert-secondary py-2 small"><i class="bi bi-wifi-off me-1"></i>${t('You are offline. Everything you do is saved on this device.')}</div>` : ''}
      ${Auth.can('backup.export') && (backupDays === null || backupDays >= 7) ? `<div class="alert alert-warning py-2 small d-flex align-items-center gap-2"><i class="bi bi-shield-exclamation"></i><div class="flex-grow-1">${backupDays === null ? t('No backup has been made on this device yet.') : `${t('Last backup was')} ${backupDays} ${t('days ago')}.`} ${t('Your data only lives on this device.')}</div><a class="btn btn-sm btn-warning" href="#/backup">${t('Back up')}</a></div>` : ''}

      <div class="section-title"><h2>${t('Needs your attention')}</h2></div>
      <div class="row g-2 stagger">
        ${alertCard('#/expiry/expired', expired.length, Math.max(batches.length, 1), '#dc2626', t('Expired'), expired.length ? `${t('Loss')} ${esc(cur())} ${fmtNum(val(expired))}` : t('Nothing expired'), expired.length > 0)}
        ${alertCard('#/expiry/d30', soon.length, Math.max(batches.length, 1), '#ea580c', t('Expiring in 30 days'), soon.length ? `${esc(cur())} ${fmtNum(val(soon))} ${t('at cost')}` : t('All good'), false)}
        ${alertCard('#/stock', low.length, Math.max(tracked.length, 1), '#d97706', t('Low / out of stock'), low.length ? t('Tap to see the list') : t('Stock levels are fine'), false)}
        ${Auth.can('demand.manage') ? alertCard('#/demand', demands.length, Math.max(demands.length, 10), '#7e22ce', t('Order list'), demands.length ? t('Items to order') : t('Nothing to order'), false) : ''}
      </div>

      <div class="section-title"><h2>${t('What do you want to do?')}</h2></div>
      <div class="row g-3 stagger">
        ${bigTile('#/pos', 'cart-plus-fill', 'sell', 'Sell', '', 'sale.create')}
        ${bigTile('#/purchase/new', 'bag-plus-fill', 'buy', 'Buy', '', 'purchase.manage')}
        ${bigTile('#/expiry', 'calendar2-x', 'expiry', 'Expiry', expired.length + soon.length ? `<span class="count">${expired.length + soon.length}</span>` : '')}
        ${bigTile('#/stock', 'capsule', 'stock', 'Stock', low.length ? `<span class="count">${low.length}</span>` : '')}
        ${bigTile('#/demand', 'clipboard2-pulse', 'demand', 'Order list', demands.length ? `<span class="count">${demands.length}</span>` : '', 'demand.manage')}
        ${bigTile('#/trace', 'binoculars', 'trace', 'Batch trace')}
        ${bigTile('#/rx', 'prescription2', 'rx', 'Rx register', '', 'reports.view')}
        ${bigTile('#/customers', 'journal-bookmark-fill', 'khata', 'Customers')}
      </div>

      <div class="section-title"><h2>${t('More')}</h2></div>
      <div class="row g-2 stagger">
        ${tile('#/products', 'capsule-pill', 'green', t('Medicines'), `${prods.length} ${t('active items')}`)}
        ${tile('#/sales', 'receipt', 'indigo', t('Sales'), `${f.salesCount} ${t('today')} · ${esc(cur())} ${fmtNum(f.sales)}`)}
        ${tile('#/purchases', 'bag-check', 'violet', t('Purchases'), `${f.purchasesCount} ${t('today')} · ${esc(cur())} ${fmtNum(f.purchases)}`, 'purchase.manage')}
        ${tile('#/suppliers', 'truck', 'slate', t('Suppliers'), `${t('Payable')} ${esc(cur())} ${fmtNum(pay)}`, 'purchase.manage')}
        ${tile('#/returns', 'arrow-return-left', 'red', t('Returns'), f.saleReturns ? `${esc(cur())} ${fmtNum(f.saleReturns)} ${t('today')}` : t('Sale & purchase returns'))}
        ${tile('#/vouchers', 'cash-coin', 'amber', t('Cash Book & Payments'), t('Receipts & payments'), 'voucher.create')}
        ${tile('#/reports', 'bar-chart-line', 'cyan', t('Reports'), t('Sales, stock, expiry, profit'), 'reports.view')}
        ${tile('#/settings', 'gear', 'slate', t('Settings'), t('Shop, printer, language'))}
      </div>

      <div class="section-title"><h2>${t('Overview')}</h2></div>
      <div class="row g-2 stagger">
        ${kpi('person-down', 'amber', t('Udhaar (receivable)'), M(rec), Auth.can('reports.view') ? '#/reports/receivables' : '#/customers')}
        ${Auth.can('purchase.manage') ? kpi('truck', 'red', t('Payables'), M(pay), Auth.can('reports.view') ? '#/reports/payables' : null) : ''}
        ${kpi('boxes', 'green', t('Stock value'), M(stockValue), '#/stock')}
        ${kpi('wallet2', 'cyan', t('Cash & bank'), M(cash), Auth.can('account.manage') ? '#/accounts' : null)}
      </div>

      <div class="row g-3 mt-1">
        <div class="col-lg-8"><div class="card viz-card h-100">
          <div class="viz-head"><div><div class="ttl">${t('Sales — last 7 days')}</div><div class="sub">${t('Total')} ${esc(cur())} ${fmtNum(wk.days.reduce((s, d) => s + d.total, 0))} · ${wk.days.reduce((s, d) => s + d.count, 0)} ${t('invoices')}</div></div>
            <a class="small fw-semibold text-decoration-none" href="#/reports/sales">${t('Report')} <i class="bi bi-chevron-right"></i></a></div>
          <div class="viz week-chart"></div>
          <details class="viz-table"><summary>${t('Show as table')}</summary>
            <table class="table table-sm table-report mt-2 mb-0"><thead><tr><th>${t('Date')}</th><th class="num">${t('Invoices')}</th><th class="num">${t('Sales')}</th></tr></thead>
            <tbody>${wk.days.map((d) => `<tr><td>${esc(fmtDate(d.date))}</td><td class="num">${d.count}</td><td class="num">${fmtNum(d.total)}</td></tr>`).join('')}</tbody></table></details>
        </div></div>
        <div class="col-lg-4"><div class="card viz-card h-100">
          <div class="viz-head"><div><div class="ttl">${t('Top medicines')}</div><div class="sub">${t('By sales amount, last 7 days')}</div></div></div>
          ${wk.top.length ? wk.top.map((p) => `<div class="hbar"><div class="name">${esc(p.name)}</div><div class="amt money">${fmtNum(p.amount)}</div>
            <div class="track"><div class="fill" style="width:${Math.max(3, (p.amount / wk.top[0].amount) * 100)}%"></div></div></div>`).join('') : UI.emptyState(t('No sales in the last 7 days'), 'graph-up')}
        </div></div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-md-6"><div class="section-title mt-0"><h2>${t('Expiring soon')}</h2><a href="#/expiry">${t('View all')}</a></div>
          <div class="list-card">${nearList.map((x) => `<a class="list-row" href="#/trace/${encodeURIComponent(x.b.id)}"><div class="main"><div class="title">${esc(medTitle(x.p))}</div><div class="sub">${t('Batch')} ${esc(x.b.batchNo)} · ${esc(stockText(x.p, x.b.qty))}</div></div><div class="end">${expiryChip(x.b.expiry)}</div></a>`).join('') || UI.emptyState(t('Nothing is expiring in the next 3 months'), 'check2-circle')}</div></div>
        <div class="col-md-6"><div class="section-title mt-0"><h2>${t('Recent sales')}</h2><a href="#/sales">${t('View all')}</a></div>
          <div class="list-card">${f.recent.map((s) => `<a class="list-row" href="#/sales/${encodeURIComponent(s.id)}">${UI.avatar(s.customerName, 'round')}<div class="main"><div class="title">${esc(s.customerName)}</div><div class="sub">${esc(s.number)} · ${fmtTime(s.createdAt)}</div></div><div class="end"><div class="fw-bold money">${fmtNum(s.total)}</div>${s.balance > 0.004 ? `<span class="badge text-bg-warning">${t('Credit')}</span>` : `<span class="badge bg-success-subtle text-success-emphasis">${t('Paid')}</span>`}</div></a>`).join('') || UI.emptyState(t('No sales yet today'), 'receipt')}</div></div>
      </div>`);

    UI.countUp(el, (v, node) => (node.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
    const chartBox = el.querySelector('.week-chart');
    drawWeekChart(chartBox, wk.days);
    this._resize = debounce(() => { if (chartBox.isConnected) drawWeekChart(chartBox, wk.days); }, 200);
    window.addEventListener('resize', this._resize);

    const refresh = () => { if (location.hash === '' || location.hash.startsWith('#/dashboard')) this.render(el); };
    this._h = refresh;
    document.addEventListener('data:changed', refresh);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    if (this._resize) window.removeEventListener('resize', this._resize);
    this._h = null; this._resize = null;
  },
};
