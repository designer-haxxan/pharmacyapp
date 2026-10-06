// Order list (demand form): what to buy from which supplier. Fed by low-stock suggestions, "customer asked" requests and manual entries.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtDate, today, num, uuid } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { storageKey } from '../config.js';
import { getSettings } from '../core/settings.js';
import { packLabel, medTitle, medSub, uomMult, packSizeOf, stockText } from '../core/pharma.js';
import { openWhatsApp, copyText } from '../core/share.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Demand from '../services/demand.js';
import { printHTML } from '../printer/printer.js';
import { partyPicker } from './parties.js';

const $ = window.jQuery;
const SRC = { manual: ['Manual', 'secondary'], 'low-stock': ['Low stock', 'warning'], 'customer-asked': ['Customer asked', 'primary'], out: ['Out of stock', 'danger'] };

function orderText(supplierName, items) {
  const b = getSettings().business;
  const lines = items.map((d, i) => {
    const p = d.productId ? Catalog.product(d.productId) : null;
    return `${i + 1}. ${d.name} — ${d.qty} ${p ? t(packLabel(p)) : ''}${d.note ? ` (${d.note})` : ''}`;
  });
  return `${b.name}\n${t('Order')}${supplierName ? ' — ' + supplierName : ''}\n${fmtDate(today())}\n\n${lines.join('\n')}\n\n${t('Thank you')}`;
}

function groupBySupplier(list) {
  const g = new Map();
  for (const d of list) {
    const key = d.supplierId || '';
    if (!g.has(key)) g.set(key, { id: d.supplierId || null, name: d.supplierName || '', items: [] });
    g.get(key).items.push(d);
  }
  return [...g.values()].sort((a, b) => (a.name || '~').localeCompare(b.name || '~'));
}

async function setSupplier(items) {
  const s = await partyPicker('suppliers', { noneLabel: t('Not decided') });
  if (s === undefined) return false;
  for (const d of items) await Posting.saveDemand({ ...d, supplierId: s?.id || null, supplierName: s?.name || '' });
  return true;
}

// Open the purchase screen with these medicines already in the cart (batch & expiry are filled when the goods arrive).
function startPurchase(group) {
  const lines = [];
  for (const d of group.items) {
    const p = d.productId ? Catalog.product(d.productId) : null;
    if (!p) continue;
    lines.push({ productId: p.id, name: medTitle(p), uom: 'pack', mult: uomMult(p, 'pack'), unitName: packLabel(p), qty: d.qty, rate: p.purchasePrice || 0, discount: 0, bonus: 0, batchNo: '', expiry: '', mrp: p.mrp || 0 });
  }
  if (!lines.length) { UI.toast(t('These items are not in your medicine list yet. Add them first.'), 'warning', 4000); return; }
  localStorage.setItem(storageKey('draft.purchase'), JSON.stringify({ mode: 'purchase', id: uuid(), editId: null, date: today(), partyId: group.id, partyName: group.name, lines, discount: 0, note: '', refNo: '', tendered: null, priceMode: 'retail', rx: {} }));
  location.hash = '#/purchase/new';
}

export default {
  async render(el) {
    const $el = $(el).off();
    const $c = $el;
    const draw = async () => {
      const [open, ordered, sugg] = await Promise.all([Demand.openDemands(), idb.getAllByIndex('demands', 'status', 'ordered'), Demand.lowStockSuggestions()]);
      const groups = groupBySupplier(open);
      $c.html(UI.pageHeader(t('Order list'), `<button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> ${t('Add')}</button>`) + `
        <div class="help-box mb-3"><i class="bi bi-lightbulb"></i><div>${t('Make a list of what to buy, send it to your supplier on WhatsApp, and receive it with New Purchase. The list updates itself when stock runs low or a customer asks for something you do not have.')}</div></div>
        ${sugg.length ? `<div class="section-title"><h2><i class="bi bi-magic me-1 text-warning"></i>${t('Running low — suggested')} (${sugg.length})</h2><a href="#" class="add-all">${t('Add all')}</a></div>
          <div class="list-card mb-3">${sugg.slice(0, 40).map((s, i) => `<div class="list-row" data-s="${i}">
            <div class="main"><div class="title">${esc(medTitle(s.product))}</div><div class="sub">${t('In stock')}: ${esc(stockText(s.product, s.product.stock))}${s.product.lastSupplierName ? ' · ' + esc(s.product.lastSupplierName) : ''}</div></div>
            <div class="end"><span class="badge text-bg-light border">${s.qty} ${esc(t(packLabel(s.product)))}</span></div>
            <button class="btn btn-sm btn-primary add-sug" aria-label="Add"><i class="bi bi-plus-lg"></i></button></div>`).join('')}</div>` : ''}
        <div class="section-title"><h2><i class="bi bi-clipboard2-pulse me-1 text-primary"></i>${t('To order')} (${open.length})</h2></div>
        ${groups.length ? groups.map((g, gi) => `<div class="card mb-3" data-g="${gi}"><div class="card-body">
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2"><div class="fw-bold"><i class="bi bi-truck me-1"></i>${esc(g.name || t('Supplier not decided'))}</div>
            <button class="btn btn-sm btn-light btn-sup"><i class="bi bi-person-gear me-1"></i>${t('Supplier')}</button></div>
          <div class="list-card mb-2">${g.items.map((d) => { const p = d.productId ? Catalog.product(d.productId) : null; const [sl, sc] = SRC[d.source] || SRC.manual; return `<div class="list-row" data-id="${esc(d.id)}">
            <div class="main"><div class="title">${esc(d.name)}</div><div class="sub"><span class="badge text-bg-${sc}">${t(sl)}</span> ${d.note ? esc(d.note) : ''}${p ? ` · ${t('In stock')}: ${esc(stockText(p, p.stock))}` : ''}</div></div>
            <button class="btn btn-sm btn-outline-secondary qty-btn">${d.qty} ${p ? esc(t(packLabel(p))) : ''}</button>
            <button class="btn btn-sm btn-light del" aria-label="Remove"><i class="bi bi-x-lg"></i></button></div>`; }).join('')}</div>
          <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-success btn-sm btn-wa"><i class="bi bi-whatsapp me-1"></i>${t('Send on WhatsApp')}</button>
            <button class="btn btn-outline-secondary btn-sm btn-print"><i class="bi bi-printer me-1"></i>${t('Print')}</button>
            <button class="btn btn-outline-secondary btn-sm btn-copy"><i class="bi bi-clipboard me-1"></i>${t('Copy')}</button>
            <button class="btn btn-outline-primary btn-sm btn-ordered"><i class="bi bi-check2-square me-1"></i>${t('Mark as ordered')}</button>
            ${Auth.can('purchase.manage') ? `<button class="btn btn-primary btn-sm btn-purchase"><i class="bi bi-bag-plus me-1"></i>${t('Receive (new purchase)')}</button>` : ''}
          </div></div></div>`).join('') : UI.emptyState(t('Your order list is empty'), 'clipboard2-check')}
        ${ordered.length ? `<div class="section-title"><h2><i class="bi bi-hourglass-split me-1"></i>${t('Ordered — waiting for delivery')} (${ordered.length})</h2></div>
          <div class="list-card">${ordered.map((d) => `<div class="list-row" data-id="${esc(d.id)}"><div class="main"><div class="title">${esc(d.name)}</div><div class="sub">${esc(d.supplierName || '')} · ${fmtDate((d.orderedAt || d.createdAt).slice(0, 10))}</div></div>
            <div class="end"><span class="badge text-bg-light border">${d.qty}</span></div><button class="btn btn-sm btn-outline-success got" title="${t('Received')}"><i class="bi bi-check2"></i></button><button class="btn btn-sm btn-light del"><i class="bi bi-x-lg"></i></button></div>`).join('')}</div>` : ''}`);
      $c.data({ groups, ordered, sugg });
    };
    await draw();
    const redraw = () => draw();
    const gOf = (n) => $c.data('groups')[+$(n).closest('[data-g]').data('g')];
    $c.on('click', '.add-sug', async function () { const s = $c.data('sugg')[+$(this).closest('[data-s]').data('s')]; await Posting.saveDemand({ productId: s.product.id, name: medTitle(s.product), qty: s.qty, source: 'low-stock', supplierId: s.product.lastSupplierId || null, supplierName: s.product.lastSupplierName || '' }); redraw(); });
    $c.on('click', '.add-all', async (e) => { e.preventDefault(); for (const s of $c.data('sugg')) await Posting.saveDemand({ productId: s.product.id, name: medTitle(s.product), qty: s.qty, source: 'low-stock', supplierId: s.product.lastSupplierId || null, supplierName: s.product.lastSupplierName || '' }); UI.toast(t('Added to order list')); redraw(); });
    $c.on('click', '.btn-add', async () => {
      const picked = await UI.pick({
        title: t('Add medicine to order list'), placeholder: t('Search medicine…'),
        addNew: { label: t('Not in my list — type the name'), create: () => Demand.addCustomerRequest('') },
        search: async (q) => Catalog.searchProducts(q, { limit: 30 }).map((p) => ({ id: p.id, title: medTitle(p), subtitle: medSub(p), right: stockText(p, p.stock), value: p })),
      });
      if (picked && picked.value) await Demand.addToOrderList(picked.value);
      redraw();
    });
    $c.on('click', '.qty-btn', async function () {
      const id = $(this).closest('[data-id]').data('id'); const d = await idb.get('demands', id);
      const r = await UI.formModal({ title: d.name, body: `<label class="form-label">${t('Quantity')}</label><input name="qty" class="form-control form-control-lg" inputmode="numeric" value="${d.qty}">`, onSubmit: (v) => Posting.saveDemand({ ...d, qty: num(v.qty, 1) }) });
      if (r) redraw();
    });
    $c.on('click', '.del', async function () { await Posting.deleteDemand($(this).closest('[data-id]').data('id')); redraw(); });
    $c.on('click', '.got', async function () { const d = await idb.get('demands', $(this).closest('[data-id]').data('id')); await Posting.saveDemand({ ...d, status: 'received', receivedAt: new Date().toISOString() }); redraw(); });
    $c.on('click', '.btn-sup', async function () { if (await setSupplier(gOf(this).items)) redraw(); });
    $c.on('click', '.btn-wa', function () { const g = gOf(this); const sup = g.id ? Catalog.party('suppliers', g.id) : null; openWhatsApp(sup?.phone || '', orderText(g.name, g.items)); });
    $c.on('click', '.btn-copy', async function () { const g = gOf(this); UI.toast((await copyText(orderText(g.name, g.items))) ? t('Copied') : t('Could not copy'), 'info'); });
    $c.on('click', '.btn-print', function () {
      const g = gOf(this); const b = getSettings().business;
      printHTML(`<div class="print-report"><h2>${esc(b.name)}</h2><div><b>${t('Order')}</b>${g.name ? ' — ' + esc(g.name) : ''} · ${esc(fmtDate(today()))}</div><br>
        <table><thead><tr><th>#</th><th>${t('Medicine')}</th><th class="num">${t('Quantity')}</th><th>${t('Note')}</th></tr></thead><tbody>${g.items.map((d, i) => { const p = d.productId ? Catalog.product(d.productId) : null; return `<tr><td>${i + 1}</td><td>${esc(d.name)}</td><td class="num">${d.qty} ${p ? esc(t(packLabel(p))) : ''}</td><td>${esc(d.note || '')}</td></tr>`; }).join('')}</tbody></table></div>`, { page: 'A4' });
    });
    $c.on('click', '.btn-ordered', async function () { for (const d of gOf(this).items) await Posting.saveDemand({ ...d, status: 'ordered', orderedAt: new Date().toISOString() }); UI.toast(t('Marked as ordered')); redraw(); });
    $c.on('click', '.btn-purchase', function () { startPurchase(gOf(this)); });
    this._h = () => { if (location.hash.startsWith('#/demand')) redraw(); };
    document.addEventListener('demand:changed', this._h);
  },
  destroy() { if (this._h) document.removeEventListener('demand:changed', this._h); this._h = null; },
};
