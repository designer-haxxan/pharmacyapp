// Sales, purchases and returns: history lists, document views, returns and voiding.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, fmtDateTime, fmtTime, today, uuid, num, round2, AppError, debounce } from '../core/utils.js';
import { money, dateFilter, bindDateFilter, pager } from '../core/views.js';
import { t } from '../core/i18n.js';
import { expiryChip, CLASSES } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;

const K = {
  sale: { store: 'sales', items: 'saleItems', fk: 'saleId', list: 'sales', party: 'customerName', partyId: 'customerId', partyRoute: 'customers', label: 'Sale', retKind: 'saleReturn', retStore: 'saleReturns', editRoute: 'pos' },
  purchase: { store: 'purchases', items: 'purchaseItems', fk: 'purchaseId', list: 'purchases', party: 'supplierName', partyId: 'supplierId', partyRoute: 'suppliers', label: 'Purchase', retKind: 'purchaseReturn', retStore: 'purchaseReturns', editRoute: 'purchase' },
};
export const RETURN_REASONS = { sale: ['Customer returned', 'Wrong medicine given', 'Doctor changed prescription', 'Damaged', 'Other'], purchase: ['Expired / near expiry', 'Damaged / broken', 'Wrong item', 'Slow moving', 'Other'] };

function statusBadge(d) {
  if (d.status === 'void') return `<span class="badge text-bg-danger">${t('Void')}</span>`;
  if (d.balance > 0.004) return `<span class="badge text-bg-warning">${d.paid > 0 ? t('Partial') : t('Credit')}</span>`;
  return '';
}
const itemName = (i) => `${esc(i.name)}${i.strength ? ' ' + esc(i.strength) : ''}`;
const batchLine = (i) => (i.batchNo ? `<div class="small d-flex flex-wrap gap-1 align-items-center"><span class="fw-bold">${esc(i.batchNo)}</span>${i.expiry ? expiryChip(i.expiry) : ''}</div>` : '');

// ---------- lists ----------
async function renderList(el, kind) {
  const k = K[kind];
  const $el = $(el);
  let from = today(); let to = today();
  const newBtn = kind === 'sale' ? (Auth.can('sale.create') ? `<a class="btn btn-primary btn-sm" href="#/pos"><i class="bi bi-plus-lg"></i> ${t('New sale')}</a>` : '')
    : `<a class="btn btn-primary btn-sm" href="#/purchase/new"><i class="bi bi-plus-lg"></i> ${t('New purchase')}</a>`;
  $el.html(UI.pageHeader(kind === 'sale' ? t('Sales') : t('Purchases'), newBtn) + dateFilter(from, to, `<div class="flex-grow-2"><label class="form-label small mb-0">${t('Search')}</label><input type="search" name="q" class="form-control form-control-sm" placeholder="${t('Number or')} ${kind === 'sale' ? t('customer') : t('supplier')}"></div>
      <div><label class="form-label small mb-0">${t('Status')}</label><select name="status" class="form-select form-select-sm"><option value="">${t('All')}</option><option value="due">${t('Unpaid / partial')}</option><option value="void">${t('Void')}</option></select></div>`) + `
    <div class="row g-2 mb-2 summary"></div><div class="list-card list"></div>`);
  let docs = [];
  const draw = () => {
    const q = ($el.find('[name=q]').val() || '').toLowerCase();
    const s = $el.find('[name=status]').val();
    const list = docs.filter((d) => (!q || `${d.number} ${d[k.party]}`.toLowerCase().includes(q))
      && (!s || (s === 'void' ? d.status === 'void' : d.status !== 'void' && d.balance > 0.004)));
    const live = list.filter((d) => d.status !== 'void');
    const tot = live.reduce((a, d) => a + d.total, 0); const paid = live.reduce((a, d) => a + d.paid, 0);
    $el.find('.summary').html([[t('Documents'), live.length, false], [t('Total'), tot, true], [t('Paid'), paid, true], [t('Due'), tot - paid, true]]
      .map(([l, v, m]) => `<div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">${l}</div><div class="fw-bold money">${m ? money(v) : v}</div></div></div></div>`).join(''));
    pager($el.find('.list'), list, (d) => `<a class="list-row" href="#/${k.list}/${encodeURIComponent(d.id)}">
      <div class="main"><div class="title">${esc(d.number)} ${statusBadge(d)} ${d.hasControlled ? `<span class="cls-badge cls-controlled">${t('Controlled')}</span>` : d.hasRx ? '<span class="cls-badge cls-rx">Rx</span>' : ''}</div><div class="sub">${esc(d[k.party])} · ${d.date === today() ? fmtTime(d.createdAt) : fmtDate(d.date)} · ${d.itemCount} ${t('item(s)')}</div></div>
      <div class="end"><div class="fw-semibold money ${d.status === 'void' ? 'text-decoration-line-through text-body-secondary' : ''}">${fmtNum(d.total)}</div>${d.balance > 0.004 && d.status !== 'void' ? `<div class="sub text-warning-emphasis">${t('due')} ${fmtNum(d.balance)}</div>` : ''}</div></a>`,
    50, UI.emptyState(kind === 'sale' ? t('No sales found for this period') : t('No purchases found for this period'), 'receipt'));
  };
  const load = async () => {
    docs = (await idb.getAllByIndex(k.store, 'date', IDBKeyRange.bound(from, to))).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    draw();
  };
  bindDateFilter($el, (f, tt) => { from = f; to = tt; load(); });
  $el.on('input', '[name=q]', debounce(draw, 150));
  $el.on('change', '[name=status]', draw);
  await load();
}

// ---------- document view ----------
async function renderDoc(el, kind, id) {
  const k = K[kind];
  const $el = $(el).off();
  const d = await idb.get(k.store, id);
  if (!d) { $el.html(UI.pageHeader(t(k.label), '', `#/${k.list}`) + UI.emptyState(t('Document not found'), 'x-circle')); return; }
  const items = d.status === 'void' ? (d.voidedItems || []) : await idb.getAllByIndex(k.items, k.fk, id);
  items.sort((a, b) => a.line - b.line);
  const returns = (await idb.getAllByIndex(k.retStore, k.fk, id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const liveReturns = returns.filter((r) => r.status !== 'void');
  const isVoid = d.status === 'void';
  const canEdit = !isVoid && !liveReturns.length && Auth.can(kind === 'sale' ? 'sale.edit' : 'purchase.manage');
  const canReturn = !isVoid && Auth.can(kind === 'sale' ? 'sale.return' : 'purchase.manage');
  const canVoid = !isVoid && !liveReturns.length && Auth.can(kind === 'sale' ? 'sale.void' : 'purchase.manage');
  const partyLink = d[k.partyId] ? `<a href="#/${k.partyRoute}/${encodeURIComponent(d[k.partyId])}">${esc(d[k.party])}</a>` : esc(d[k.party]);
  const rx = d.rx;
  $el.html(UI.pageHeader(d.number, `<button class="btn btn-light btn-sm btn-print"><i class="bi bi-printer"></i><span class="d-none d-sm-inline"> ${t('Print')}</span></button>
      <div class="dropdown"><button class="btn btn-light btn-sm" data-bs-toggle="dropdown" aria-label="Actions"><i class="bi bi-three-dots-vertical"></i></button><ul class="dropdown-menu dropdown-menu-end">
        ${canEdit ? `<li><a class="dropdown-item" href="#/${k.editRoute}/edit/${encodeURIComponent(id)}"><i class="bi bi-pencil me-2"></i>${t('Edit')}</a></li>` : ''}
        ${canReturn ? `<li><button class="dropdown-item btn-return"><i class="bi bi-arrow-return-left me-2"></i>${t('Return items')}</button></li>` : ''}
        ${canVoid ? `<li><button class="dropdown-item text-danger btn-void"><i class="bi bi-x-circle me-2"></i>${t('Void')}</button></li>` : ''}
        ${!canEdit && !canReturn && !canVoid ? `<li><span class="dropdown-item-text small text-body-secondary">${t('No actions available')}</span></li>` : ''}
      </ul></div>`, `#/${k.list}`) + `
    ${isVoid ? `<div class="alert alert-danger">${t('Voided')} ${fmtDateTime(d.voidedAt)} ${t('by')} ${esc(d.voidedBy)}${d.voidReason ? ': ' + esc(d.voidReason) : ''}. ${t('Stock and ledger effects were reversed.')}</div>` : ''}
    <div class="row g-3">
      <div class="col-lg-8">
        <div class="card mb-3"><div class="card-body">
          <div class="d-flex justify-content-between flex-wrap gap-2 mb-2">
            <div><div class="small text-body-secondary">${kind === 'sale' ? t('Customer') : t('Supplier')}</div><div class="fw-semibold">${partyLink}</div></div>
            <div class="text-end"><div class="small text-body-secondary">${t('Date')}</div><div>${fmtDate(d.date)} <span class="text-body-secondary small">${fmtTime(d.createdAt)}</span></div></div>
          </div>
          <div class="table-responsive"><table class="table table-sm table-report mb-0">
            <thead><tr><th>${t('Medicine')}</th><th class="num">${t('Qty')}</th><th class="num">${t('Rate')}</th><th class="num">${t('Disc')}</th><th class="num">${t('Amount')}</th></tr></thead>
            <tbody>${items.map((i) => `<tr><td>${itemName(i)}${batchLine(i)}${i.dir ? `<div class="small text-primary"><i class="bi bi-chat-left-text"></i> ${esc(i.dir)}</div>` : ''}</td>
              <td class="num">${fmtQty(i.qty)} ${esc(t(i.unit || ''))}${i.bonus ? `<div class="small text-success">+${fmtQty(i.bonus)} ${t('bonus')}</div>` : ''}</td><td class="num">${fmtNum(i.rate)}</td><td class="num">${i.discount ? fmtNum(i.discount) : ''}</td><td class="num">${fmtNum(i.amount)}</td></tr>`).join('')}</tbody>
          </table></div></div></div>
        ${returns.length ? `<h2 class="h6">${t('Returns')}</h2><div class="list-card mb-3">${returns.map((r) => `<a class="list-row" href="#/returns/${kind}/${encodeURIComponent(r.id)}"><div class="main"><div class="title">${esc(r.number)} ${r.status === 'void' ? `<span class="badge text-bg-danger">${t('Void')}</span>` : ''}</div><div class="sub">${fmtDate(r.date)} · ${r.items.length} ${t('item(s)')}</div></div><div class="end money">${fmtNum(r.total)}</div></a>`).join('')}</div>` : ''}
      </div>
      <div class="col-lg-4">
        <div class="card mb-3"><div class="card-body">
          <table class="table table-sm mb-0 table-borderless">
            <tr><td>${t('Subtotal')}</td><td class="text-end money">${fmtNum(d.subtotal)}</td></tr>
            ${d.discount ? `<tr><td>${t('Discount')}</td><td class="text-end money">−${fmtNum(d.discount)}</td></tr>` : ''}
            ${d.tax ? `<tr><td>${t('Tax')} (${d.taxRate}%)</td><td class="text-end money">${fmtNum(d.tax)}</td></tr>` : ''}
            <tr class="fw-bold border-top"><td>${t('Total')}</td><td class="text-end money">${money(d.total)}</td></tr>
            <tr><td>${t('Paid')} (${esc(d.paymentAccountName)})</td><td class="text-end money">${fmtNum(d.paid)}</td></tr>
            ${d.change ? `<tr><td>${t('Change given')}</td><td class="text-end money">${fmtNum(d.change)}</td></tr>` : ''}
            <tr class="${d.balance > 0.004 ? 'text-warning-emphasis fw-semibold' : ''}"><td>${t('Balance due')}</td><td class="text-end money">${fmtNum(d.balance)}</td></tr>
            ${liveReturns.length ? `<tr><td>${t('Returned')}</td><td class="text-end money">−${fmtNum(liveReturns.reduce((s, r) => s + r.total, 0))}</td></tr>` : ''}
          </table></div></div>
        ${rx ? `<div class="card mb-3 border-${d.hasControlled ? 'danger' : 'primary'}-subtle"><div class="card-body small">
          <div class="fw-bold mb-1 text-${d.hasControlled ? 'danger' : 'primary'}"><i class="bi bi-prescription2 me-1"></i>${t('Prescription')}</div>
          <div><span class="text-body-secondary">${t('Patient')}:</span> ${esc(rx.patient || '—')}</div><div><span class="text-body-secondary">${t('Doctor')}:</span> ${esc(rx.doctor || '—')}</div>
          ${rx.phone ? `<div><span class="text-body-secondary">${t('Phone')}:</span> ${esc(rx.phone)}</div>` : ''}${rx.note ? `<div><span class="text-body-secondary">${t('Note')}:</span> ${esc(rx.note)}</div>` : ''}</div></div>` : ''}
        <div class="card"><div class="card-body small">
          <div><span class="text-body-secondary">${t('Entered by')}:</span> ${esc(d.userName || '—')}</div>
          <div><span class="text-body-secondary">${t('Created')}:</span> ${fmtDateTime(d.createdAt)}</div>
          ${d.edited ? `<div><span class="text-body-secondary">${t('Last edited')}:</span> ${fmtDateTime(d.updatedAt)}</div>` : ''}
          ${d.refNo ? `<div><span class="text-body-secondary">${t('Supplier invoice')}:</span> ${esc(d.refNo)}</div>` : ''}
          ${d.note ? `<div><span class="text-body-secondary">${t('Note')}:</span> ${esc(d.note)}</div>` : ''}
        </div></div>
      </div></div>`);
  $el.on('click', '.btn-print', () => Printer.printDocument(kind, d));
  $el.on('click', '.btn-return', async () => { const r = await returnDialog(kind, d); if (r) location.hash = `#/returns/${kind}/${r.id}`; });
  $el.on('click', '.btn-void', async () => {
    const reason = await UI.formModal({ title: `${t('Void')} ${d.number}`, submitLabel: t('Void document'), submitClass: 'btn-danger',
      body: `<p>${t('Voiding reverses stock (batch by batch) and all ledger entries. The number stays reserved for audit purposes. This cannot be undone.')}</p><label class="form-label">${t('Reason')}</label><input name="reason" class="form-control" required>`,
      onSubmit: (v) => { if (!v.reason.trim()) throw new AppError(t('Enter a reason.')); return v.reason; } });
    if (!reason) return;
    try { await Posting.voidDocument(kind, id, reason); UI.toast(`${d.number} ${t('voided')}`); renderDoc(el, kind, id); } catch (e) { UI.toastError(e); }
  });
}

// ---------- return dialog ----------
// preselect: { batchId } puts that batch's remaining returnable quantity in the form (used by the Expiry screen).
export async function returnDialog(kind, d, { preselect = null, defaultReason = '' } = {}) {
  const lines = (await Posting.returnableLines(kind, d.id)).filter((l) => l.remaining > 0);
  if (!lines.length) { UI.toast(t('Everything in this document has already been returned.'), 'info'); return null; }
  const factor = d.subtotal > 0 ? d.total / d.subtotal : 1;
  const hasParty = !!d[K[kind].partyId];
  const payAccounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active);
  const retId = uuid();
  const reasons = RETURN_REASONS[kind];
  const calc = ($m) => round2(lines.reduce((s, l, i) => s + round2(l.amount * factor * num($m.find(`[name=q${i}]`).val()) / l.qty), 0));
  return UI.formModal({
    title: `${t('Return')} — ${d.number}`, submitLabel: t('Save return'), size: 'lg',
    body: `<div class="d-flex justify-content-end mb-2"><button type="button" class="btn btn-sm btn-outline-secondary btn-all">${t('Return all')}</button></div>
      <div class="list-card mb-3">${lines.map((l, i) => `<div class="list-row"><div class="main"><div class="title">${itemName(l)}</div>
        <div class="sub">${l.batchNo ? `${t('Batch')} ${esc(l.batchNo)} · ` : ''}${kind === 'sale' ? t('Sold') : t('Bought')} ${fmtQty(l.qty)} ${esc(t(l.unit || ''))} · ${t('returned')} ${fmtQty(l.returned)} · ${t('max')} ${fmtQty(l.remaining)} · @ ${fmtNum(round2(l.amount * factor / l.qty))}</div></div>
        <input name="q${i}" class="form-control text-end" style="width:90px" inputmode="decimal" placeholder="0" data-max="${l.remaining}" data-mult="${l.mult || 1}" data-batch="${esc(l.batchId || '')}"></div>`).join('')}</div>
      <div class="d-flex justify-content-between fs-5 mb-2"><span>${t('Return total')}</span><b class="money rt">0.00</b></div>
      <div class="row g-2">
        <div class="col-12"><label class="form-label">${t('Reason')}</label><select name="reason" class="form-select">${reasons.map((r) => `<option ${r === defaultReason ? 'selected' : ''}>${esc(t(r))}</option>`).join('')}</select></div>
        <div class="col-6"><label class="form-label">${kind === 'sale' ? t('Refund paid') : t('Refund received')}</label><input name="refund" class="form-control" inputmode="decimal" ${hasParty ? '' : 'readonly'}>
          <div class="form-text">${hasParty ? (kind === 'sale' ? t('Unrefunded amount is adjusted in the customer account.') : t('Unrefunded amount is adjusted in the supplier account.')) : t('Walk-in/cash documents are refunded in full.')}</div></div>
        <div class="col-6"><label class="form-label">${t('Account')}</label><select name="account" class="form-select">${UI.options(payAccounts, d.paymentAccountId)}</select></div>
        <div class="col-6"><label class="form-label">${t('Date')}</label><input type="date" name="date" class="form-control" value="${today()}" max="${today()}"></div>
        <div class="col-6"><label class="form-label">${t('Note')}</label><input name="note" class="form-control"></div>
      </div>`,
    onShown: ($m) => {
      let refundTouched = false;
      const upd = () => { const tt = calc($m); $m.find('.rt').text(money(tt).replace(/&amp;/g, '&')); if (!refundTouched || !hasParty) $m.find('[name=refund]').val(hasParty && d.balance > 0.004 ? 0 : tt); };
      $m.on('input', '[name^=q]', upd);
      $m.on('input', '[name=refund]', () => { refundTouched = true; });
      $m.find('.btn-all').on('click', () => { $m.find('[name^=q]').each(function () { this.value = this.dataset.max; }); upd(); });
      if (preselect?.batchId) $m.find(`[data-batch="${preselect.batchId}"]`).each(function () { this.value = Math.min(+this.dataset.max, Math.floor((preselect.baseQty ?? Infinity) / +this.dataset.mult + 1e-9) || +this.dataset.max); });
      upd();
      $m.find('[name^=q]').filter((_, e) => e.value).first().trigger('focus');
      if (!preselect) $m.find('[name=q0]').trigger('focus');
    },
    onSubmit: async (v) => {
      const input = { id: retId, docId: d.id, date: v.date, refund: v.refund, refundAccountId: v.account, note: v.note, reason: v.reason,
        lines: lines.map((l, i) => ({ lineId: l.id, qty: v['q' + i] })) };
      const { doc } = await Posting.saveReturn(kind, input);
      UI.toast(`${doc.number} ${t('saved')}`);
      return doc;
    },
  });
}

// ---------- returns ----------
async function renderReturns(el) {
  const $el = $(el);
  let from = today(); let to = today();
  $el.html(UI.pageHeader(t('Returns'), '') + `<div class="help-box mb-3"><i class="bi bi-info-circle"></i><div>${t('To create a return, open the original sale or purchase and choose Return items. Expired medicines can be returned to the supplier from the Expiry screen.')}</div></div>
    ${dateFilter(from, to, `<div><label class="form-label small mb-0">${t('Type')}</label><select name="kind" class="form-select form-select-sm">${Auth.can('purchase.manage') ? `<option value="">${t('All')}</option>` : ''}<option value="sale">${t('Sale returns')}</option>${Auth.can('purchase.manage') ? `<option value="purchase">${t('Purchase returns')}</option>` : ''}</select></div>`)}
    <div class="list-card list"></div>`);
  const load = async (kind = $el.find('[name=kind]').val()) => {
    const range = IDBKeyRange.bound(from, to);
    const [s, p] = await Promise.all([
      !kind || kind === 'sale' ? idb.getAllByIndex('saleReturns', 'date', range) : [],
      (!kind || kind === 'purchase') && Auth.can('purchase.manage') ? idb.getAllByIndex('purchaseReturns', 'date', range) : [],
    ]);
    const list = [...s.map((r) => ({ ...r, kind: 'sale' })), ...p.map((r) => ({ ...r, kind: 'purchase' }))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    pager($el.find('.list'), list, (r) => `<a class="list-row" href="#/returns/${r.kind}/${encodeURIComponent(r.id)}">
      <div class="thumb"><i class="bi bi-arrow-return-left"></i></div>
      <div class="main"><div class="title">${esc(r.number)} ${r.status === 'void' ? `<span class="badge text-bg-danger">${t('Void')}</span>` : ''}</div><div class="sub">${r.kind === 'sale' ? t('Sale return') : t('Purchase return')} · ${esc(r.docNo)} · ${esc(r.partyName || '')} · ${fmtDate(r.date)}</div></div>
      <div class="end fw-semibold money">${fmtNum(r.total)}</div></a>`, 50, UI.emptyState(t('No returns in this period'), 'arrow-return-left'));
  };
  bindDateFilter($el, (f, tt, fd) => { from = f; to = tt; load(fd.kind); });
  await load();
}

async function renderReturn(el, kind, id) {
  const $el = $(el).off();
  const store = kind === 'sale' ? 'saleReturns' : 'purchaseReturns';
  const r = await idb.get(store, id);
  if (!r) { $el.html(UI.pageHeader(t('Return'), '', '#/returns') + UI.emptyState(t('Return not found'), 'x-circle')); return; }
  const retKind = kind === 'sale' ? 'saleReturn' : 'purchaseReturn';
  const canVoid = r.status !== 'void' && Auth.can(kind === 'sale' ? 'sale.void' : 'purchase.manage');
  $el.html(UI.pageHeader(r.number, `<button class="btn btn-light btn-sm btn-print"><i class="bi bi-printer"></i> ${t('Print')}</button>${canVoid ? `<button class="btn btn-outline-danger btn-sm btn-void"><i class="bi bi-x-circle"></i> ${t('Void')}</button>` : ''}`, '#/returns') + `
    ${r.status === 'void' ? `<div class="alert alert-danger">${t('Voided')} ${fmtDateTime(r.voidedAt)} ${t('by')} ${esc(r.voidedBy)}</div>` : ''}
    <div class="card"><div class="card-body">
      <div class="mb-2">${kind === 'sale' ? t('Sale return') : t('Purchase return')} ${t('against')} <a href="#/${K[kind].list}/${encodeURIComponent(r[K[kind].fk])}">${esc(r.docNo)}</a> · ${esc(r.partyName || '')} · ${fmtDate(r.date)}${r.reason ? ` · <b>${esc(r.reason)}</b>` : ''}</div>
      <div class="table-responsive"><table class="table table-sm table-report"><thead><tr><th>${t('Medicine')}</th><th class="num">${t('Qty')}</th><th class="num">${t('Rate')}</th><th class="num">${t('Amount')}</th></tr></thead>
      <tbody>${r.items.map((i) => `<tr><td>${esc(i.name)}${batchLine(i)}</td><td class="num">${fmtQty(i.qty)} ${esc(t(i.unit || ''))}</td><td class="num">${fmtNum(i.rate)}</td><td class="num">${fmtNum(i.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="fw-bold"><td colspan="3">${t('Total')}</td><td class="num">${money(r.total)}</td></tr>
      <tr><td colspan="3">${t('Refund')} (${esc(r.refundAccountName)})</td><td class="num">${fmtNum(r.refund)}</td></tr></tfoot></table></div>
      <div class="small text-body-secondary">${t('By')} ${esc(r.userName)} · ${fmtDateTime(r.createdAt)}${r.note ? ' · ' + esc(r.note) : ''}</div>
    </div></div>`);
  $el.on('click', '.btn-print', () => Printer.printDocument(retKind, r));
  $el.on('click', '.btn-void', async () => {
    if (!await UI.confirmDialog(`${t('Void')} ${r.number}? ${t('Stock and ledger effects of this return will be reversed.')}`, { okLabel: t('Void'), okClass: 'btn-danger' })) return;
    try { await Posting.voidDocument(retKind, id); UI.toast(t('Return voided')); renderReturn(el, kind, id); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el, { route, params }) {
    if (route === 'returns') {
      if (params[0] && params[1]) await renderReturn(el, params[0], params[1]); else await renderReturns(el);
      return;
    }
    const kind = route === 'sales' ? 'sale' : 'purchase';
    if (params[0]) await renderDoc(el, kind, params[0]); else await renderList(el, kind);
  },
};
