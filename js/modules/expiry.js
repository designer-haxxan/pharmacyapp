// Expiry manager: every batch with its expiry date, colour coded, with write-off and return-to-supplier actions.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, round2, today, debounce } from '../core/utils.js';
import { money } from '../core/views.js';
import { t } from '../core/i18n.js';
import { daysLeft, expiryChip, stockText, medTitle, fmtExpiry, expiryInfo } from '../core/pharma.js';
import { getSettings } from '../core/settings.js';
import { openWhatsApp, copyText } from '../core/share.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import { printHTML } from '../printer/printer.js';
import { returnDialog } from './documents.js';

const $ = window.jQuery;

const BUCKETS = [
  ['expired', 'Expired', (d) => d < 0, '#dc2626'],
  ['d30', '30 days', (d) => d >= 0 && d <= 30, '#ea580c'],
  ['d60', '31–60 days', (d) => d > 30 && d <= 60, '#d97706'],
  ['d90', '61–90 days', (d) => d > 60 && d <= 90, '#ca8a04'],
  ['d180', '3–6 months', (d) => d > 90 && d <= 180, '#16a34a'],
  ['all', 'All batches', () => true, '#0f9d73'],
];

const costValue = (b) => round2(b.qty * (b.cost || 0));

function rows() {
  return Catalog.allBatches().map((b) => ({ b, p: Catalog.product(b.productId), days: daysLeft(b.expiry) })).filter((r) => r.p)
    .sort((a, b) => a.b.expiry.localeCompare(b.b.expiry) || a.p.name.localeCompare(b.p.name));
}

function ring(count, total, color) {
  const frac = total ? Math.max(count ? 0.1 : 0, count / total) : 0;
  const off = (138.2 * (1 - frac)).toFixed(1);
  return `<div class="ring-wrap"><svg viewBox="0 0 54 54"><circle class="ring-bg" cx="27" cy="27" r="22"/><circle class="ring-fg" cx="27" cy="27" r="22" style="--off:${off};--ring:${color}"/></svg><span class="n">${count}</span></div>`;
}

function returnListText(items, supplierName) {
  const b = getSettings().business;
  const lines = items.map((r, i) => `${i + 1}. ${medTitle(r.p)} | ${t('Batch')} ${r.b.batchNo} | ${t('Exp')} ${fmtExpiry(r.b.expiry)} | ${stockText(r.p, r.b.qty)}`);
  return `${b.name}\n${t('Expiry return list')}${supplierName ? ' — ' + supplierName : ''}\n${fmtDate(today())}\n\n${lines.join('\n')}\n\n${t('Total value')}: ${getSettings().currency} ${fmtNum(items.reduce((s, r) => s + costValue(r.b), 0))}`;
}

async function showReturnList(items) {
  // Group by supplier of the batch.
  const groups = new Map();
  for (const r of items) { const k = r.b.supplierName || t('Unknown supplier'); (groups.get(k) || groups.set(k, { id: r.b.supplierId, items: [] }).get(k)).items.push(r); }
  const m = UI.modal({
    title: t('Expiry return list'), size: 'lg',
    body: items.length ? [...groups.entries()].map(([name, g]) => {
      const sup = g.id ? Catalog.party('suppliers', g.id) : null;
      return `<div class="card mb-3" data-sup="${esc(name)}"><div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-bold"><i class="bi bi-truck me-1"></i>${esc(name)}</div><div class="fw-bold money">${money(g.items.reduce((s, r) => s + costValue(r.b), 0))}</div></div>
        <div class="table-responsive"><table class="table table-sm table-report mb-2"><thead><tr><th>${t('Medicine')}</th><th>${t('Batch')}</th><th>${t('Expiry')}</th><th class="num">${t('Qty')}</th></tr></thead>
          <tbody>${g.items.map((r) => `<tr><td>${esc(medTitle(r.p))}</td><td>${esc(r.b.batchNo)}</td><td>${expiryChip(r.b.expiry)}</td><td class="num">${esc(stockText(r.p, r.b.qty))}</td></tr>`).join('')}</tbody></table></div>
        <div class="d-flex flex-wrap gap-2"><button class="btn btn-success btn-sm btn-wa" data-phone="${esc(sup?.phone || '')}"><i class="bi bi-whatsapp me-1"></i>${t('Send on WhatsApp')}</button>
          <button class="btn btn-outline-secondary btn-sm btn-copy"><i class="bi bi-clipboard me-1"></i>${t('Copy')}</button></div></div></div>`;
    }).join('') : UI.emptyState(t('Nothing to return'), 'check2-circle'),
  });
  m.$el.on('click', '.btn-wa', function () { const name = $(this).closest('[data-sup]').data('sup'); openWhatsApp(this.dataset.phone, returnListText(groups.get(name).items, name)); });
  m.$el.on('click', '.btn-copy', async function () { const name = $(this).closest('[data-sup]').data('sup'); UI.toast((await copyText(returnListText(groups.get(name).items, name))) ? t('Copied') : t('Could not copy'), 'info'); });
  await m.closed;
}

async function returnToSupplier(r) {
  const b = r.b;
  if (b.srcType !== 'purchase') { UI.toast(t('This batch was not bought through a purchase bill, so it cannot be returned to a supplier. Use Write off instead.'), 'warning', 5000); return false; }
  const doc = await idb.get('purchases', b.srcId);
  if (!doc || doc.status === 'void') { UI.toast(t('The purchase bill of this batch was not found.'), 'warning'); return false; }
  const res = await returnDialog('purchase', doc, { preselect: { batchId: b.id, baseQty: b.qty }, defaultReason: 'Expired / near expiry' });
  if (res) UI.toast(`${res.number} ${t('saved')}`);
  return !!res;
}

export default {
  async render(el, { params }) {
    const $el = $(el).off();
    let bucket = params[0] || 'd30';
    if (!BUCKETS.some((x) => x[0] === bucket)) bucket = 'd30';
    const canAdj = Auth.can('stock.adjust');
    $el.html(UI.pageHeader(t('Expiry'), `<button class="btn btn-light btn-sm btn-retlist"><i class="bi bi-box-arrow-up-right"></i><span class="d-none d-sm-inline"> ${t('Return list')}</span></button>`) + `
      <div class="row g-2 mb-3 buckets stagger"></div>
      <div class="filters"><div class="input-group flex-grow-2"><span class="input-group-text bg-body"><i class="bi bi-search"></i></span><input type="search" class="form-control q" placeholder="${t('Search medicine or batch…')}"></div></div>
      <div class="small text-body-secondary mb-2 summary"></div>
      <div class="list-card list"></div>`);
    const draw = () => {
      const all = rows();
      const q = ($el.find('.q').val() || '').toLowerCase();
      $el.find('.buckets').html(BUCKETS.map(([k, label, test, color]) => {
        const sel = all.filter((r) => test(r.days));
        const value = sel.reduce((s, r) => s + costValue(r.b), 0);
        return `<div class="col-4 col-md-2"><div class="bucket ${k === bucket ? 'active' : ''}" data-b="${k}" style="--bc:${color}">${ring(sel.length, all.length, color)}<div class="bl mt-1">${t(label)}</div><div class="bv money">${fmtNum(value)}</div></div></div>`;
      }).join(''));
      const test = BUCKETS.find((x) => x[0] === bucket)[2];
      const list = all.filter((r) => test(r.days) && (!q || `${r.p.name} ${r.p.generic || ''} ${r.b.batchNo}`.toLowerCase().includes(q)));
      const val = list.reduce((s, r) => s + costValue(r.b), 0);
      $el.find('.summary').html(`${list.length} ${t('batches')} · ${t('Value at cost')}: <b class="money">${money(val)}</b>`);
      $el.find('.list').html(list.length ? list.map((r, i) => {
        const info = expiryInfo(r.b.expiry);
        return `<div class="list-row" data-i="${i}">
          <div class="main"><div class="title">${esc(medTitle(r.p))}</div>
            <div class="sub">${t('Batch')} <b>${esc(r.b.batchNo)}</b>${r.b.supplierName ? ' · ' + esc(r.b.supplierName) : ''}</div>
            <div class="d-flex flex-wrap gap-1 mt-1">${expiryChip(r.b.expiry)}<span class="exp-chip exp-${info.level}">${info.days < 0 ? `${-info.days} ${t('days ago')}` : `${info.days} ${t('days left')}`}</span></div></div>
          <div class="end"><div class="fw-bold">${esc(stockText(r.p, r.b.qty))}</div><div class="sub money">${money(costValue(r.b))}</div>
            ${canAdj ? `<div class="dropdown mt-1"><button class="btn btn-sm btn-light" data-bs-toggle="dropdown" aria-label="Actions"><i class="bi bi-three-dots"></i></button><ul class="dropdown-menu dropdown-menu-end">
              <li><button class="dropdown-item act-return"><i class="bi bi-arrow-return-left me-2"></i>${t('Return to supplier')}</button></li>
              <li><button class="dropdown-item act-writeoff text-danger"><i class="bi bi-trash3 me-2"></i>${t('Write off (destroy)')}</button></li>
              <li><a class="dropdown-item" href="#/trace/${encodeURIComponent(r.b.id)}"><i class="bi bi-binoculars me-2"></i>${t('Batch trace')}</a></li></ul></div>` : ''}</div></div>`;
      }).join('') : UI.emptyState(bucket === 'expired' ? t('No expired medicines. Well done!') : t('Nothing in this period'), 'check2-circle'));
      $el.data('list', list);
    };
    draw();
    $el.on('click', '.bucket', function () { bucket = this.dataset.b; draw(); });
    $el.on('input', '.q', debounce(draw, 150));
    $el.on('click', '.act-return', async function () { const r = $el.data('list')[+$(this).closest('[data-i]').data('i')]; if (await returnToSupplier(r)) draw(); });
    $el.on('click', '.act-writeoff', async function () {
      const r = $el.data('list')[+$(this).closest('[data-i]').data('i')];
      if (!await UI.confirmDialog(`${t('Write off')} ${stockText(r.p, r.b.qty)} ${t('of')} ${medTitle(r.p)} (${t('Batch')} ${r.b.batchNo})? ${t('Loss at cost')}: ${getSettings().currency} ${fmtNum(costValue(r.b))}`, { okLabel: t('Write off'), okClass: 'btn-danger' })) return;
      try { await Posting.writeOffBatch(r.b.id, r.days < 0 ? 'Expired' : 'Damaged'); UI.toast(t('Written off')); draw(); } catch (e) { UI.toastError(e); }
    });
    $el.on('click', '.btn-retlist', () => {
      const list = (rows().filter((r) => BUCKETS.find((x) => x[0] === bucket)[2](r.days)));
      showReturnList(list);
    });
    this._h = () => { if (location.hash.startsWith('#/expiry')) draw(); };
    document.addEventListener('data:changed', this._h);
  },
  destroy() { if (this._h) document.removeEventListener('data:changed', this._h); this._h = null; },
};
