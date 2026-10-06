// Batch trace: find a batch (by medicine or batch number), see where it came from and exactly who it was sold to.
// Used for drug recalls ("batch B1234 of X is withdrawn") and for supplier disputes.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtDateTime, round3, today, debounce, uuid } from '../core/utils.js';
import { money } from '../core/views.js';
import { t } from '../core/i18n.js';
import { expiryChip, stockText, medTitle, daysLeft } from '../core/pharma.js';
import { getSettings } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import { printHTML } from '../printer/printer.js';
import { returnDialog } from './documents.js';

const $ = window.jQuery;

async function findBatches(q) {
  q = q.trim();
  if (!q) return [];
  const up = q.toUpperCase();
  const [byNo, all] = await Promise.all([
    idb.getAllByIndex('batches', 'batchNo', IDBKeyRange.bound(up, up + '￿')),
    Promise.resolve(Catalog.searchProducts(q, { limit: 8, includeInactive: true })),
  ]);
  const byProd = (await Promise.all(all.map((p) => idb.getAllByIndex('batches', 'productId', p.id)))).flat();
  const seen = new Set(); const out = [];
  for (const b of [...byNo, ...byProd]) if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
  return out.sort((a, b) => b.receivedDate.localeCompare(a.receivedDate)).slice(0, 80);
}

async function renderSearch(el) {
  const $el = $(el).off();
  $el.html(UI.pageHeader(t('Batch trace')) + `
    <div class="help-box mb-3"><i class="bi bi-binoculars"></i><div>${t('Type a medicine name or a batch number. You will see the supplier it came from and every customer who bought it — useful when a company recalls a batch.')}</div></div>
    <div class="input-group input-group-lg mb-3"><span class="input-group-text bg-body"><i class="bi bi-search"></i></span><input type="search" class="form-control q" placeholder="${t('Medicine name or batch number')}" autocomplete="off"></div>
    <div class="list-card list"></div>`);
  const draw = async () => {
    const q = $el.find('.q').val();
    const list = await findBatches(q);
    $el.find('.list').html(list.length ? list.map((b) => { const p = Catalog.product(b.productId); return `<a class="list-row" href="#/trace/${encodeURIComponent(b.id)}">
      <div class="main"><div class="title">${esc(p ? medTitle(p) : '?')}</div><div class="sub">${t('Batch')} <b>${esc(b.batchNo)}</b> · ${esc(b.supplierName || t('Opening stock'))} · ${fmtDate(b.receivedDate)}</div></div>
      <div class="end">${expiryChip(b.expiry)}<div class="sub mt-1">${b.qty > 0 ? esc(stockText(p, b.qty)) + ' ' + t('left') : t('sold out')}</div></div></a>`; }).join('')
      : UI.emptyState(q ? t('No batch found') : t('Search to begin'), 'binoculars'));
  };
  $el.on('input', '.q', debounce(draw, 200));
  await draw();
  $el.find('.q').trigger('focus');
}

async function renderBatch(el, id) {
  const $el = $(el).off();
  const b = await idb.get('batches', id);
  if (!b) { $el.html(UI.pageHeader(t('Batch trace'), '', '#/trace') + UI.emptyState(t('Batch not found'), 'x-circle')); return; }
  const p = Catalog.product(b.productId);
  const [items, moves] = await Promise.all([idb.getAllByIndex('saleItems', 'batchId', id), idb.getAllByIndex('stockMoves', 'batchId', id)]);
  const sales = new Map((await Promise.all([...new Set(items.map((i) => i.saleId))].map((sid) => idb.get('sales', sid)))).filter(Boolean).map((s) => [s.id, s]));
  const custs = new Map();
  for (const s of sales.values()) if (s.customerId && !custs.has(s.customerId)) custs.set(s.customerId, Catalog.party('customers', s.customerId) || await idb.get('customers', s.customerId));
  const sold = round3(items.reduce((s, i) => s + i.baseQty, 0));
  const returned = round3(moves.filter((m) => m.type === 'sale_return').reduce((s, m) => s + m.qty, 0));
  const adjusted = round3(moves.filter((m) => m.type === 'adjust' && m.qty < 0).reduce((s, m) => s - m.qty, 0));
  const purchase = b.srcType === 'purchase' ? await idb.get('purchases', b.srcId) : null;
  const days = daysLeft(b.expiry);
  const rows = items.map((i) => ({ i, s: sales.get(i.saleId), c: custs.get(sales.get(i.saleId)?.customerId) })).filter((r) => r.s).sort((a, c) => a.s.date.localeCompare(c.s.date));
  $el.html(UI.pageHeader(p ? medTitle(p) : t('Batch'), `<button class="btn btn-light btn-sm btn-recall"><i class="bi bi-printer"></i><span class="d-none d-sm-inline"> ${t('Recall list')}</span></button>`, '#/trace') + `
    <div class="card mb-3"><div class="card-body">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2"><span class="fs-4 fw-bold">${esc(b.batchNo)}</span>${expiryChip(b.expiry)}${days < 0 ? `<span class="badge text-bg-danger">${t('Expired')}</span>` : ''}</div>
      <div class="row g-2 small">
        <div class="col-6 col-md-3"><div class="text-body-secondary">${t('Supplier')}</div><div class="fw-bold">${esc(b.supplierName || '—')}</div></div>
        <div class="col-6 col-md-3"><div class="text-body-secondary">${t('Purchase bill')}</div><div class="fw-bold">${purchase ? `<a href="#/purchases/${encodeURIComponent(purchase.id)}">${esc(purchase.number)}</a>${purchase.refNo ? ' · ' + esc(purchase.refNo) : ''}` : esc(b.srcNo || '—')}</div></div>
        <div class="col-6 col-md-3"><div class="text-body-secondary">${t('Received on')}</div><div class="fw-bold">${fmtDate(b.receivedDate)}</div></div>
        <div class="col-6 col-md-3"><div class="text-body-secondary">MRP / ${t('Cost')}</div><div class="fw-bold money">${fmtNum(b.mrp)} / ${fmtNum((b.cost || 0) * (p?.packSize || 1))}</div></div>
      </div></div></div>
    <div class="row g-2 mb-3 stagger">${[[t('Received'), b.qtyIn, 'box-arrow-in-down', 'indigo'], [t('Sold'), sold, 'cart-check', 'green'], [t('Returned by customers'), returned, 'arrow-return-left', 'amber'], [t('Removed / written off'), adjusted, 'trash3', 'red'], [t('Remaining'), b.qty, 'boxes', 'cyan']]
      .map(([l, v, ic, tint]) => `<div class="col-6 col-md"><div class="card stat-card"><div class="card-body py-2 kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${ic}"></i></div><div class="min-w-0"><div class="stat-label">${l}</div><div class="fw-bold">${esc(stockText(p, v))}</div></div></div></div></div>`).join('')}</div>
    <div class="d-flex flex-wrap gap-2 mb-3">
      ${b.qty > 0 && Auth.can('stock.adjust') ? `<button class="btn btn-outline-danger btn-sm btn-wo"><i class="bi bi-trash3 me-1"></i>${t('Write off remaining')}</button>` : ''}
      ${b.qty > 0 && purchase && Auth.can('purchase.manage') ? `<button class="btn btn-outline-primary btn-sm btn-ret"><i class="bi bi-arrow-return-left me-1"></i>${t('Return to supplier')}</button>` : ''}</div>
    <h2 class="h6">${t('Sold to')} (${rows.length})</h2>
    <div class="card"><div class="table-responsive"><table class="table table-sm table-report mb-0"><thead><tr><th>${t('Date')}</th><th>${t('Invoice')}</th><th>${t('Customer')}</th><th>${t('Phone')}</th><th class="num">${t('Qty')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="text-nowrap">${fmtDate(r.s.date)}</td><td><a href="#/sales/${encodeURIComponent(r.s.id)}">${esc(r.s.number)}</a></td><td>${esc(r.s.customerName)}${r.s.rx?.patient ? `<div class="small text-body-secondary">${esc(r.s.rx.patient)}</div>` : ''}</td><td>${esc(r.c?.phone || r.s.rx?.phone || '')}</td><td class="num">${esc(stockText(p, r.i.baseQty))}</td></tr>`).join('') || `<tr><td colspan="5" class="text-center text-body-secondary py-3">${t('Not sold yet')}</td></tr>`}</tbody></table></div></div>`);
  $el.on('click', '.btn-recall', () => {
    const bz = getSettings().business;
    printHTML(`<div class="print-report"><h2>${esc(bz.name)}</h2><div><b>${t('Batch recall list')}</b> · ${esc(fmtDateTime(new Date().toISOString()))}</div>
      <div>${t('Medicine')}: <b>${esc(p ? medTitle(p) : '')}</b> · ${t('Batch')}: <b>${esc(b.batchNo)}</b> · ${t('Expiry')}: ${esc(b.expiry)} · ${t('Supplier')}: ${esc(b.supplierName || '—')}</div>
      <div>${t('Received')}: ${esc(stockText(p, b.qtyIn))} · ${t('Sold')}: ${esc(stockText(p, sold))} · ${t('Remaining')}: ${esc(stockText(p, b.qty))}</div><br>
      <table><thead><tr><th>${t('Date')}</th><th>${t('Invoice')}</th><th>${t('Customer')}</th><th>${t('Phone')}</th><th class="num">${t('Qty')}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.s.date)}</td><td>${esc(r.s.number)}</td><td>${esc(r.s.customerName)}</td><td>${esc(r.c?.phone || r.s.rx?.phone || '')}</td><td class="num">${esc(stockText(p, r.i.baseQty))}</td></tr>`).join('')}</tbody></table></div>`, { page: 'A4' });
  });
  $el.on('click', '.btn-wo', async () => {
    if (!await UI.confirmDialog(`${t('Write off')} ${stockText(p, b.qty)}?`, { okLabel: t('Write off'), okClass: 'btn-danger' })) return;
    try { await Posting.writeOffBatch(id, days < 0 ? 'Expired' : 'Damaged'); UI.toast(t('Written off')); renderBatch(el, id); } catch (e) { UI.toastError(e); }
  });
  $el.on('click', '.btn-ret', async () => { if (await returnDialog('purchase', purchase, { preselect: { batchId: id, baseQty: b.qty } })) renderBatch(el, id); });
}

export default {
  async render(el, { params }) { if (params[0]) await renderBatch(el, params[0]); else await renderSearch(el); },
};
