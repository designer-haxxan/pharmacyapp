// Stock: batch-wise stock per medicine, stock ledger, adjustments (add batch / remove / count).
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtDateTime, today, monthStart, uuid, num, round3, debounce, AppError } from '../core/utils.js';
import { money, dateFilter, bindDateFilter, pager } from '../core/views.js';
import { t } from '../core/i18n.js';
import { stockText, packSizeOf, packsOf, isLowStock, expiryChip, fmtExpiry, medTitle, medSub, uomsOf, uomMult, parseExpiry } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';
import { clsBadge, fridgeBadge, stockPill, productActions } from './products.js';

const $ = window.jQuery;
export const MOVE_LABELS = { opening: 'Opening stock', sale: 'Sale', purchase: 'Purchase', sale_return: 'Sale return', purchase_return: 'Purchase return', adjust: 'Adjustment' };
const moveLink = (m) => {
  const r = { sale: `#/sales/${m.refId}`, purchase: `#/purchases/${m.refId}`, sale_return: `#/returns/sale/${m.refId}`, purchase_return: `#/returns/purchase/${m.refId}`, adjust: `#/stock/adjustment/${m.refId}` }[m.type];
  return r ? `<a href="${esc(r)}">${esc(m.refNo)}</a>` : esc(m.refNo);
};

async function renderCurrent(el) {
  const $el = $(el).off();
  const canAdj = Auth.can('stock.adjust');
  $el.html(UI.pageHeader(t('Stock'), `${canAdj ? `<a class="btn btn-light btn-sm" href="#/stock/adjustments"><i class="bi bi-clock-history"></i><span class="d-none d-sm-inline"> ${t('Adjustments')}</span></a><a class="btn btn-primary btn-sm" href="#/stock/adjust"><i class="bi bi-plus-slash-minus"></i> ${t('Add / adjust')}</a>` : ''}`) + `
    <div class="row g-2 mb-3 cards stagger"></div>
    <div class="filters"><div class="input-group flex-grow-2"><span class="input-group-text bg-body"><i class="bi bi-search"></i></span><input type="search" class="form-control q" placeholder="${t('Search medicine, salt, company…')}"></div>
      <select class="form-select f"><option value="all">${t('All stock')}</option><option value="in">${t('In stock')}</option><option value="low">${t('Low stock')}</option><option value="out">${t('Out of stock')}</option><option value="fridge">${t('Fridge items')}</option></select></div>
    <div class="list-card list"></div>`);
  const tracked = () => Catalog.allProducts().filter((p) => p.active && p.trackStock !== false);
  const all = tracked();
  const value = all.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePrice || 0) / packSizeOf(p), 0);
  const retail = all.reduce((s, p) => s + Math.max(0, p.stock) * (p.salePrice || 0) / packSizeOf(p), 0);
  const low = all.filter((p) => isLowStock(p)).length;
  const cardData = [[t('Medicines'), all.length, 'capsule', 'green'], [t('Stock value (cost)'), money(value), 'wallet2', 'indigo'], [t('Retail value'), money(retail), 'tags', 'cyan'], [t('Low / out of stock'), low, 'exclamation-triangle', low ? 'amber' : 'green']];
  $el.find('.cards').html(cardData.map(([l, v, ic, tint]) => `<div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2 kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${ic}"></i></div><div class="min-w-0"><div class="stat-label">${l}</div><div class="fw-bold money">${v}</div></div></div></div></div>`).join(''));
  const draw = () => {
    const q = $el.find('.q').val(); const f = $el.find('.f').val();
    const ids = new Set(Catalog.searchProducts(q, { limit: Infinity }).map((p) => p.id));
    const list = tracked().filter((p) => ids.has(p.id) && (f === 'all' || (f === 'in' && p.stock > 0) || (f === 'low' && isLowStock(p)) || (f === 'out' && p.stock <= 0) || (f === 'fridge' && p.storage === 'fridge')))
      .sort((a, b) => a.name.localeCompare(b.name));
    pager($el.find('.list'), list, (p) => {
      const bs = Catalog.batches(p.id); const near = bs[0]?.expiry;
      return `<button class="list-row" data-id="${esc(p.id)}">
        <div class="main"><div class="title">${esc(medTitle(p))}</div><div class="sub">${esc(medSub(p))}</div>
          <div class="d-flex flex-wrap gap-1 mt-1">${clsBadge(p)}${fridgeBadge(p)}${near ? expiryChip(near) : ''}${bs.length > 1 ? `<span class="cls-badge cls-general">${bs.length} ${t('batches')}</span>` : ''}</div></div>
        <div class="end">${stockPill(p)}<div class="sub mt-1">${t('Min')} ${p.minStock || 0} · ${fmtNum(Math.max(0, p.stock) * (p.purchasePrice || 0) / packSizeOf(p))}</div></div></button>`;
    }, 60, UI.emptyState(t('No medicines match'), 'boxes'));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f', draw);
  $el.on('click', '.list-row[data-id]', function () { productActions(Catalog.product(this.dataset.id), draw); });
}

async function renderLedger(el, productId) {
  const $el = $(el).off();
  const p = Catalog.product(productId);
  if (!p) { $el.html(UI.pageHeader(t('Stock history'), '', '#/stock') + UI.emptyState(t('Medicine not found'), 'x-circle')); return; }
  let from = monthStart(); let to = today();
  const bs = Catalog.batches(p.id);
  $el.html(UI.pageHeader(medTitle(p), Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-primary btn-sm" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-plus-slash-minus"></i> ${t('Add / adjust')}</a>` : '', '#/stock') + `
    <div class="card stat-card mb-3"><div class="card-body"><div class="stat-label">${t('Current stock')}</div><div class="stat-value">${p.trackStock === false ? t('Not tracked') : esc(stockText(p, p.stock))}</div>
      ${bs.length ? `<div class="mt-2">${bs.map((b) => `<div class="batch-row px-0"><div class="flex-grow-1"><span class="bn">${esc(b.batchNo)}</span> ${expiryChip(b.expiry)}</div><div class="fw-bold">${esc(stockText(p, b.qty))}</div></div>`).join('')}</div>` : ''}</div></div>
    ${dateFilter(from, to)}<div class="card"><div class="card-body p-0 ledger"></div></div>`);
  const load = async () => {
    const [before, rows] = await idb.read(['stockMoves'], (tx) => Promise.all([
      tx.getAllByIndex('stockMoves', 'prodDate', IDBKeyRange.bound([productId, ''], [productId, from], false, true)),
      tx.getAllByIndex('stockMoves', 'prodDate', IDBKeyRange.bound([productId, from], [productId, to])),
    ]));
    const opening = round3(before.reduce((s, m) => s + m.qty, 0));
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    let run = opening; let inQ = 0; let outQ = 0;
    const body = rows.map((m) => { run = round3(run + m.qty); if (m.qty > 0) inQ += m.qty; else outQ -= m.qty; return `<tr>
      <td class="text-nowrap">${fmtDate(m.date)}</td><td>${moveLink(m)}<div class="small text-body-secondary">${esc(t(MOVE_LABELS[m.type] || m.type))}${m.note && m.type === 'adjust' ? ' · ' + esc(m.note) : ''}</div></td>
      <td class="small">${esc(m.batchNo || '')}<div>${m.expiry ? fmtExpiry(m.expiry) : ''}</div></td>
      <td class="num text-success">${m.qty > 0 ? esc(stockText(p, m.qty)) : ''}</td><td class="num text-danger">${m.qty < 0 ? esc(stockText(p, -m.qty)) : ''}</td><td class="num fw-semibold">${esc(stockText(p, run))}</td></tr>`; }).join('');
    $el.find('.ledger').html(`<div class="table-responsive"><table class="table table-sm table-report mb-0"><thead><tr><th>${t('Date')}</th><th>${t('Reference')}</th><th>${t('Batch')}</th><th class="num">${t('In')}</th><th class="num">${t('Out')}</th><th class="num">${t('Balance')}</th></tr></thead>
      <tbody><tr class="table-light"><td colspan="5">${t('Opening')}</td><td class="num fw-semibold">${esc(stockText(p, opening))}</td></tr>${body || `<tr><td colspan="6" class="text-center text-body-secondary py-3">${t('No movements in this period')}</td></tr>`}</tbody>
      <tfoot><tr class="fw-semibold"><td colspan="3">${t('Totals / closing')}</td><td class="num">${esc(stockText(p, inQ))}</td><td class="num">${esc(stockText(p, outQ))}</td><td class="num">${esc(stockText(p, run))}</td></tr></tfoot></table></div>`);
  };
  bindDateFilter($el, (f, tt) => { from = f; to = tt; load(); });
  await load();
}

const REASONS = ['Stock count correction', 'Damaged', 'Expired', 'Lost / theft', 'Opening stock', 'Stock in (other)', 'Other'];

async function renderAdjust(el, productId) {
  Auth.require('stock.adjust');
  const $el = $(el).off();
  const lines = [];
  const id = uuid();
  $el.html(UI.pageHeader(t('Add / adjust stock'), '', '#/stock') + `
    <div class="help-box mb-3"><i class="bi bi-lightbulb"></i><div>${t('To receive new stock from a supplier use New Purchase (it records the supplier bill). Use this page for opening stock, damaged or expired medicines and stock counts.')}</div></div>
    <div class="card mb-3"><div class="card-body">
      <div class="input-group mb-2"><input type="search" class="form-control q" placeholder="${t('Search medicine to add…')}"><button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div>
      <div class="list-card results mb-2 d-none"></div>
      <div class="lines"></div>
      <div class="row g-2 mt-2">
        <div class="col-6"><label class="form-label">${t('Reason')}</label><select class="form-select reason">${REASONS.map((r) => `<option value="${esc(r)}">${esc(t(r))}</option>`).join('')}</select></div>
        <div class="col-6"><label class="form-label">${t('Date')}</label><input type="date" class="form-control date" value="${today()}" max="${today()}"></div>
        <div class="col-12"><label class="form-label">${t('Note')}</label><input class="form-control note"></div>
      </div>
      <button class="btn btn-primary btn-lg w-100 mt-3 btn-save">${t('Save adjustment')}</button>
    </div></div>`);
  const toBase = (l) => {
    const p = Catalog.product(l.productId);
    return round3(num(l.qty) * uomMult(p, l.uom));
  };
  const change = (l) => {
    const p = Catalog.product(l.productId);
    const b = Catalog.batches(p.id).find((x) => x.id === l.batchId);
    const base = toBase(l);
    if (l.batchId === 'new') return base;
    return l.mode === 'set' ? round3(base - (b?.qty || 0)) : l.mode === 'out' ? -base : base;
  };
  const drawLines = () => {
    $el.find('.lines').html(lines.length ? lines.map((l, i) => {
      const p = Catalog.product(l.productId);
      const bs = Catalog.batches(p.id);
      const b = bs.find((x) => x.id === l.batchId);
      const isNew = l.batchId === 'new';
      const ch = change(l);
      const uoms = uomsOf(p);
      return `<div class="card mb-2" data-i="${i}"><div class="card-body py-2">
        <div class="d-flex justify-content-between align-items-start"><div><div class="fw-bold">${esc(medTitle(p))}</div><div class="small text-body-secondary">${t('Stock')}: ${esc(stockText(p, p.stock))}</div></div>
          <button class="btn btn-sm btn-light rm" aria-label="Remove"><i class="bi bi-x-lg"></i></button></div>
        <div class="row g-2 mt-1">
          <div class="col-12"><select class="form-select form-select-sm batch">${bs.map((x) => `<option value="${esc(x.id)}" ${x.id === l.batchId ? 'selected' : ''}>${esc(x.batchNo)} · ${fmtExpiry(x.expiry)} · ${esc(stockText(p, x.qty))}</option>`).join('')}<option value="new" ${isNew ? 'selected' : ''}>＋ ${t('New batch')}</option></select></div>
          ${isNew ? `<div class="col-4"><input class="form-control form-control-sm text-uppercase nb-no" placeholder="${t('Batch no.')}" value="${esc(l.batchNo || '')}"></div>
            <div class="col-4"><input class="form-control form-control-sm nb-exp" inputmode="numeric" maxlength="7" placeholder="MM/YY" value="${esc(l.expiry || '')}"></div>
            <div class="col-4"><input class="form-control form-control-sm nb-mrp" inputmode="decimal" placeholder="MRP" value="${esc(l.mrp ?? p.mrp ?? '')}"></div>` : ''}
          <div class="col-4"><select class="form-select form-select-sm mode" ${isNew ? 'disabled' : ''}><option value="in" ${l.mode === 'in' || isNew ? 'selected' : ''}>${t('Add (+)')}</option><option value="out" ${l.mode === 'out' && !isNew ? 'selected' : ''}>${t('Remove (−)')}</option><option value="set" ${l.mode === 'set' && !isNew ? 'selected' : ''}>${t('Set count')}</option></select></div>
          <div class="col-4"><input class="form-control form-control-sm qty text-end" inputmode="decimal" value="${esc(l.qty)}" placeholder="${t('Qty')}"></div>
          <div class="col-4"><select class="form-select form-select-sm uom">${uoms.map((u) => `<option value="${u.key}" ${u.key === l.uom ? 'selected' : ''}>${esc(t(u.label))}</option>`).join('')}</select></div>
        </div>
        <div class="small mt-1">${isNew ? `${t('New batch')}: +${esc(stockText(p, Math.max(0, ch)))}` : `${t('Batch')} ${esc(b?.batchNo || '')}: ${esc(stockText(p, b?.qty || 0))} → <b>${esc(stockText(p, (b?.qty || 0) + ch))}</b> (${ch >= 0 ? '+' : '−'}${esc(stockText(p, Math.abs(ch)))})`}</div>
      </div></div>`;
    }).join('') : UI.emptyState(t('Search a medicine to adjust its stock'), 'sliders'));
  };
  const add = (p) => {
    if (!p) return;
    if (p.trackStock === false) return UI.toast(t('This item does not track stock'), 'warning');
    const bs = Catalog.batches(p.id);
    lines.push({ productId: p.id, batchId: bs[0]?.id || 'new', mode: bs.length ? 'set' : 'in', qty: '', uom: 'pack', batchNo: '', expiry: '', mrp: p.mrp });
    $el.find('.q').val(''); $el.find('.results').addClass('d-none'); drawLines();
    $el.find('.qty').last().trigger('focus');
  };
  drawLines();
  if (productId) add(Catalog.product(productId));
  let res = [];
  $el.on('input', '.q', debounce(() => {
    const q = $el.find('.q').val().trim();
    if (!q) return $el.find('.results').addClass('d-none');
    res = Catalog.searchProducts(q, { limit: 10 }).filter((p) => p.trackStock !== false);
    $el.find('.results').removeClass('d-none').html(res.map((p, i) => `<button class="list-row" data-r="${i}"><div class="main"><div class="title">${esc(medTitle(p))}</div><div class="sub">${esc(medSub(p))}</div></div><div class="end">${esc(stockText(p, p.stock))}</div></button>`).join('') || `<div class="p-2 small text-body-secondary">${t('No match')}</div>`);
  }, 150));
  $el.on('keydown', '.q', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(Catalog.findByCode($el.find('.q').val()) || res[0]); } });
  $el.on('click', '[data-r]', function () { add(res[+this.dataset.r]); });
  $el.on('click', '.btn-scan', async () => { const c = await Scanner.scan(); if (c) { const p = Catalog.findByCode(c); if (p) add(p); else UI.toast(`${t('No medicine for')} ${c}`, 'warning'); } });
  const row = (node) => lines[+$(node).closest('[data-i]').data('i')];
  $el.on('change', '.batch', function () { const l = row(this); l.batchId = this.value; if (this.value === 'new') l.mode = 'in'; drawLines(); });
  $el.on('change', '.mode', function () { row(this).mode = this.value; drawLines(); });
  $el.on('change', '.uom', function () { row(this).uom = this.value; drawLines(); });
  $el.on('input', '.qty', function () { row(this).qty = this.value; });
  $el.on('change', '.qty', drawLines);
  $el.on('input', '.nb-no', function () { row(this).batchNo = this.value; });
  $el.on('input', '.nb-mrp', function () { row(this).mrp = this.value; });
  $el.on('input', '.nb-exp', function () { const d = this.value.replace(/[^\d]/g, '').slice(0, 4); this.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; row(this).expiry = this.value; });
  $el.on('click', '.rm', function () { lines.splice(+$(this).closest('[data-i]').data('i'), 1); drawLines(); });
  let busy = false;
  $el.on('click', '.btn-save', async function () {
    if (busy) return; busy = true; $(this).prop('disabled', true);
    try {
      const out = lines.map((l) => {
        const p = Catalog.product(l.productId);
        if (l.qty === '' || num(l.qty) < 0) throw new AppError(`${t('Enter a valid quantity for')} ${p.name}.`);
        const line = { productId: l.productId, qty: change(l) };
        if (l.batchId === 'new') {
          if (!l.batchNo.trim() || !parseExpiry(l.expiry)) throw new AppError(`${t('Enter batch number and expiry (MM/YY) for the new batch of')} ${p.name}.`);
          line.newBatch = { batchNo: l.batchNo, expiry: l.expiry, mrp: l.mrp, costPack: p.purchasePrice };
        } else line.batchId = l.batchId;
        return line;
      });
      const { doc } = await Posting.saveAdjustment({ id, date: $el.find('.date').val(), reason: $el.find('.reason').val(), note: $el.find('.note').val(), lines: out });
      UI.toast(`${doc.number} ${t('saved')}`);
      location.hash = `#/stock/adjustment/${doc.id}`;
    } catch (e) { UI.toastError(e); } finally { busy = false; $(this).prop('disabled', false); }
  });
}

async function renderAdjustments(el) {
  const $el = $(el).off();
  let from = monthStart(); let to = today();
  $el.html(UI.pageHeader(t('Stock adjustments'), `<a class="btn btn-primary btn-sm" href="#/stock/adjust"><i class="bi bi-plus-lg"></i> ${t('New')}</a>`, '#/stock') + dateFilter(from, to) + '<div class="list-card list"></div>');
  const load = async () => {
    const list = (await idb.getAllByIndex('adjustments', 'date', IDBKeyRange.bound(from, to))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    pager($el.find('.list'), list, (a) => `<a class="list-row" href="#/stock/adjustment/${encodeURIComponent(a.id)}"><div class="main"><div class="title">${esc(a.number)} ${a.status === 'void' ? `<span class="badge text-bg-danger">${t('Void')}</span>` : ''}</div><div class="sub">${fmtDate(a.date)} · ${esc(t(a.reason))} · ${a.items.length} ${t('medicine(s)')}</div></div></a>`, 50, UI.emptyState(t('No adjustments in this period'), 'sliders'));
  };
  bindDateFilter($el, (f, tt) => { from = f; to = tt; load(); });
  await load();
}

async function renderAdjustment(el, id) {
  const $el = $(el).off();
  const a = await idb.get('adjustments', id);
  if (!a) { $el.html(UI.pageHeader(t('Adjustment'), '', '#/stock/adjustments') + UI.emptyState(t('Not found'), 'x-circle')); return; }
  $el.html(UI.pageHeader(a.number, a.status !== 'void' && Auth.can('stock.adjust') ? `<button class="btn btn-outline-danger btn-sm btn-void"><i class="bi bi-x-circle"></i> ${t('Void')}</button>` : '', '#/stock/adjustments') + `
    ${a.status === 'void' ? `<div class="alert alert-danger">${t('Voided')} ${fmtDateTime(a.voidedAt)} ${t('by')} ${esc(a.voidedBy)}</div>` : ''}
    <div class="card"><div class="card-body"><div class="mb-2">${fmtDate(a.date)} · <b>${esc(t(a.reason))}</b>${a.note ? ' · ' + esc(a.note) : ''}</div>
    <div class="table-responsive"><table class="table table-sm table-report"><thead><tr><th>${t('Medicine')}</th><th>${t('Batch')}</th><th class="num">${t('Before')}</th><th class="num">${t('Change')}</th><th class="num">${t('Value')}</th></tr></thead>
    <tbody>${a.items.map((i) => { const p = Catalog.product(i.productId); return `<tr><td><a href="#/stock/${encodeURIComponent(i.productId)}">${esc(i.name)}${i.strength ? ' ' + esc(i.strength) : ''}</a></td><td>${esc(i.batchNo || '')}<div class="small">${i.expiry ? expiryChip(i.expiry) : ''}</div></td><td class="num">${esc(stockText(p, i.before))}</td><td class="num ${i.qty < 0 ? 'text-danger' : 'text-success'}">${i.qty > 0 ? '+' : '−'}${esc(stockText(p, Math.abs(i.qty)))}</td><td class="num">${fmtNum(i.qty * i.cost)}</td></tr>`; }).join('')}</tbody></table></div>
    <div class="small text-body-secondary">${t('By')} ${esc(a.userName)} · ${fmtDateTime(a.createdAt)}</div></div></div>`);
  $el.on('click', '.btn-void', async () => {
    if (!await UI.confirmDialog(`${t('Void')} ${a.number}? ${t('Stock changes will be reversed.')}`, { okLabel: t('Void'), okClass: 'btn-danger' })) return;
    try { await Posting.voidDocument('adjustment', id); UI.toast(t('Adjustment voided')); renderAdjustment(el, id); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el, { params }) {
    const [a, b] = params;
    if (!a) return renderCurrent(el);
    if (a === 'adjust') return renderAdjust(el, b);
    if (a === 'adjustments') return renderAdjustments(el);
    if (a === 'adjustment') return renderAdjustment(el, b);
    return renderLedger(el, a);
  },
};
