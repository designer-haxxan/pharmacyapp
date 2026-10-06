// Pharmacy counter screen used for both sales (#/pos) and purchases (#/purchase/new).
// Edit: #/pos/edit/:id, #/purchase/edit/:id
//  - SALE: medicines are sold first-expiry-first-out (the batch is picked automatically, expired batches are never used),
//          loose units (single tablets) or packs (strips), directions for the patient, prescription details for Rx.
//  - PURCHASE: every medicine needs batch no. + expiry; bonus (free) packs and MRP are recorded per batch.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, uuid, round2, round3, num, debounce, today, AppError } from '../core/utils.js';
import { getSettings, pref } from '../core/settings.js';
import { storageKey } from '../config.js';
import { t } from '../core/i18n.js';
import { FORM_LIST, DIRECTIONS, uomsOf, uomLabel, uomMult, unitPrice, packSizeOf, boxSizeOf, stockText, expiryChip, fmtExpiry, parseExpiry, allocateFEFO, medTitle, medSub, CLASSES } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';
import * as Scanner from '../scanner/scanner.js';
import { partyPicker } from './parties.js';
import { clsBadge, fridgeBadge, stockPill, showAlternatives } from './products.js';

const $ = window.jQuery;
let st; let $root; let detachWedge = null; let payAccounts = [];

const isSale = () => st.mode === 'sale';
const draftKey = () => storageKey('draft.' + st.mode);
const cur = () => getSettings().currency;

function fresh(mode) {
  return { mode, id: uuid(), editId: null, date: today(), partyId: null, partyName: '', lines: [], discount: 0, note: '', refNo: '', tendered: null, priceMode: pref.get('priceMode', 'retail'), rx: { patient: '', doctor: '', phone: '', note: '' } };
}
function persist() { if (!st.editId) { try { localStorage.setItem(draftKey(), JSON.stringify(st)); } catch { /* quota */ } } }
function taxRate() {
  if (!isSale()) return 0;
  if (st.editId) return st.taxRate || 0;
  const s = getSettings(); return s.taxEnabled ? num(s.taxRate) : 0;
}
function totals() {
  return Posting.previewDoc(st.lines, st.discount, taxRate()) || { subtotal: 0, discount: 0, tax: 0, total: 0, qtyTotal: 0, lines: [] };
}

// ---------- prices & stock preview ----------
// Cost of one `key` unit for a purchase line.
function costFor(p, key) {
  const pack = p.purchasePrice || 0;
  if (key === 'unit') return round2(pack / packSizeOf(p));
  if (key === 'box') return round2(pack * boxSizeOf(p));
  return pack;
}
function rateFor(p, key) { return isSale() ? unitPrice(p, key, st.priceMode) : costFor(p, key); }

function preview(l) {
  const p = Catalog.product(l.productId);
  if (!p || p.trackStock === false) return { chunks: [], short: 0, p };
  const a = allocateFEFO(Catalog.batches(p.id), round3(l.qty * l.mult), { preferId: l.batchId, onDate: st.date || today() });
  return { ...a, p };
}

// ---------- rendering ----------
function layout() {
  const sale = isSale();
  return `<div class="pos">
    <div class="pos-left">
      <div class="d-flex gap-2 mb-2">
        <input type="search" class="form-control browse-q" placeholder="${t('Filter medicines…')}" autocomplete="off">
        <button class="btn btn-light d-lg-none btn-close-browse" aria-label="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="chips mb-2 cat-chips"></div>
      <div class="product-grid"></div>
    </div>
    <div class="pos-right">
      <div class="pos-search">
        <div class="input-group input-group-lg">
          <span class="input-group-text bg-body"><i class="bi bi-search"></i></span>
          <input type="search" class="form-control pos-q" placeholder="${t('Type medicine name, salt or scan barcode')}" autocomplete="off" enterkeyhint="search" aria-label="Search medicine">
          <button class="btn btn-outline-secondary btn-scan" title="${t('Scan with camera')}" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button>
          <button class="btn btn-outline-secondary btn-browse d-lg-none" title="${t('Browse medicines')}" aria-label="Browse"><i class="bi bi-grid-3x3-gap"></i></button>
        </div>
        <div class="search-results d-none"></div>
      </div>
      <div class="pos-meta">
        <button class="btn btn-light btn-party text-truncate"><i class="bi bi-person me-1"></i><span class="party-name"></span></button>
        ${sale ? `<button class="btn btn-light flex-grow-0 btn-holds" title="${t('Held sales')}"><i class="bi bi-pause-circle"></i> <span class="badge text-bg-secondary holds-count"></span></button>` : ''}
        <div class="dropdown flex-grow-0">
          <button class="btn btn-light" data-bs-toggle="dropdown" aria-label="More options"><i class="bi bi-three-dots-vertical"></i></button>
          <ul class="dropdown-menu dropdown-menu-end">
            ${sale ? `<li><button class="dropdown-item btn-hold"><i class="bi bi-pause-circle me-2"></i>${t('Hold this sale')}</button></li>
            <li><button class="dropdown-item btn-price-mode"><i class="bi bi-tags me-2"></i><span class="pm-label"></span></button></li>` : ''}
            <li><button class="dropdown-item btn-scan-cont"><i class="bi bi-upc-scan me-2"></i>${t('Continuous scan')}</button></li>
            <li><button class="dropdown-item btn-quick-add"><i class="bi bi-plus-square me-2"></i>${t('Add new medicine')}</button></li>
            <li><button class="dropdown-item btn-asked"><i class="bi bi-clipboard2-plus me-2"></i>${t('Customer asked — not available')}</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item text-danger btn-clear"><i class="bi bi-trash me-2"></i>${st.editId ? t('Cancel editing') : t('Clear cart')}</button></li>
          </ul>
        </div>
      </div>
      ${st.editId ? `<div class="alert alert-warning rounded-0 m-0 py-1 px-3 small"><i class="bi bi-pencil me-1"></i>${t('Editing')} ${esc(st.editNumber)}</div>` : ''}
      <div class="pos-lines"></div>
      <div class="pos-footer">
        <div class="d-flex justify-content-between small text-body-secondary footer-sub"></div>
        <div class="d-flex align-items-center gap-2 mt-1">
          <div class="flex-grow-1"><div class="small text-body-secondary">${t('Total')}</div><div class="total money"></div></div>
          <button class="btn btn-primary btn-pay"><i class="bi bi-${sale ? 'cash-coin' : 'bag-check'} me-1"></i>${sale ? t('Pay') : t('Save')}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function uomSeg(l, i) {
  const p = Catalog.product(l.productId);
  if (!p) return '';
  const list = uomsOf(p, { purchase: !isSale() });
  if (list.length < 2) return '';
  return `<span class="seg uom-seg" data-i="${i}">${list.map((u) => `<button type="button" data-u="${u.key}" class="${u.key === l.uom ? 'active' : ''}">${esc(t(u.label))}</button>`).join('')}</span>`;
}

function renderLines() {
  const $l = $root.find('.pos-lines');
  if (!st.lines.length) {
    $l.html(UI.emptyState(isSale() ? t('The cart is empty. Search or scan a medicine to start.') : t('No medicines yet. Search or scan to add purchased items.'), isSale() ? 'cart-plus' : 'box-seam'));
  } else {
    $l.html(st.lines.map((l, i) => {
      const p = Catalog.product(l.productId);
      const amt = round2(l.qty * l.rate - (l.discount || 0));
      let meta = '';
      if (isSale()) {
        const pv = preview(l);
        const first = pv.chunks[0]?.batch;
        const short = pv.short > 0 && !st.editId;
        meta = `${p && (p.drugClass === 'rx' || p.drugClass === 'controlled') ? clsBadge(p) : ''}${first ? `<span class="small fw-bold">${esc(first.batchNo)}</span>${expiryChip(first.expiry)}${pv.chunks.length > 1 ? `<span class="small">+${pv.chunks.length - 1}</span>` : ''}` : ''}
          <span>${fmtNum(l.rate)}/${esc(t(uomLabel(p, l.uom)))}${l.discount ? ` · ${t('disc')} ${fmtNum(l.discount)}` : ''}</span>
          ${short ? `<span class="text-danger fw-bold"><i class="bi bi-exclamation-triangle-fill"></i> ${t('Only')} ${esc(stockText(p, pv.chunks.reduce((s, c) => s + c.base, 0)))}</span><button class="btn btn-sm btn-outline-primary py-0 btn-line-alt" data-i="${i}">${t('Alternatives')}</button>` : ''}
          ${l.dir ? `<span class="text-primary"><i class="bi bi-chat-left-text"></i> ${esc(l.dir)}</span>` : ''}`;
      } else {
        const ok = !p || p.trackStock === false || (l.batchNo && parseExpiry(l.expiry));
        meta = `${ok ? `<span class="small fw-bold">${esc(l.batchNo || '')}</span>${l.expiry ? expiryChip(parseExpiry(l.expiry)) : ''}` : `<span class="text-danger fw-bold"><i class="bi bi-exclamation-triangle-fill"></i> ${t('Tap to enter batch & expiry')}</span>`}
          <span>${fmtNum(l.rate)}/${esc(t(uomLabel(p, l.uom)))}${l.bonus ? ` · ${t('bonus')} ${l.bonus}` : ''}${l.discount ? ` · ${t('disc')} ${fmtNum(l.discount)}` : ''}</span>`;
      }
      return `<div class="cart-line" data-i="${i}">
        <div class="info btn-line" role="button" tabindex="0">
          <div class="name">${esc(p ? medTitle(p) : l.name)}</div>
          <div class="meta">${meta}</div>
          <div class="mt-1">${uomSeg(l, i)}</div>
        </div>
        <div class="qty-ctl"><button class="btn-dec" aria-label="Decrease">−</button><input class="qty-in" inputmode="decimal" value="${String(round3(l.qty))}" aria-label="Quantity"><button class="btn-inc" aria-label="Increase">+</button></div>
        <div class="amt money">${fmtNum(amt)}</div>
      </div>`;
    }).join(''));
  }
  renderTotals();
}

function renderTotals() {
  const tt = totals();
  $root.find('.total').text(`${cur()} ${fmtNum(tt.total)}`);
  $root.find('.footer-sub').html(`<span>${st.lines.length} ${t('item(s)')}</span><span>${tt.discount ? `${t('Disc')} ${fmtNum(tt.discount)} · ` : ''}${tt.tax ? `${t('Tax')} ${fmtNum(tt.tax)}` : ''}</span>`);
  $root.find('.btn-pay').prop('disabled', !st.lines.length);
  $root.find('.party-name').text(st.partyName || (isSale() ? t('Walk-in Customer') : t('Select supplier')));
  $root.find('.pm-label').text(st.priceMode === 'retail' ? t('Use wholesale prices') : t('Use retail prices'));
  persist();
}

async function renderHoldCount() {
  if (!isSale()) return;
  const n = await idb.count('holds');
  $root.find('.holds-count').text(n || '');
}

// ---------- browse grid ----------
let browseForm = null;
function renderGrid() {
  const q = $root.find('.browse-q').val() || '';
  const list = Catalog.searchProducts(q, { limit: 120, form: browseForm });
  const forms = FORM_LIST.filter((f) => Catalog.allProducts().some((p) => p.form === f));
  $root.find('.cat-chips').html(`<span class="chip ${!browseForm ? 'active' : ''}" data-cat="">${t('All')}</span>` + forms.map((f) => `<span class="chip ${browseForm === f ? 'active' : ''}" data-cat="${esc(f)}">${esc(t(f))}</span>`).join(''));
  $root.find('.product-grid').html(list.length ? list.map((p) => `
    <button class="product-tile ${p.trackStock !== false && p.stock <= 0 ? 'out' : ''}" data-id="${esc(p.id)}">
      ${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : `<div class="ph tint-${UI.tintFor(p.name)}"><i class="bi bi-${p.form === 'Syrup' || p.form === 'Suspension' ? 'droplet-half' : p.form === 'Injection' ? 'eyedropper' : p.form === 'Cream' || p.form === 'Ointment' ? 'tubes' : 'capsule-pill'}"></i></div>`}
      <div class="n">${esc(medTitle(p))}</div>
      <div class="p">${fmtNum(isSale() ? unitPrice(p, 'pack', st.priceMode) : p.purchasePrice)}</div>
      ${p.trackStock !== false ? `<div class="s">${p.stock > 0 ? esc(stockText(p, p.stock)) : t('Out of stock')}</div>` : ''}
    </button>`).join('') : UI.emptyState(t('No medicines'), 'capsule'));
}

// ---------- cart operations ----------
function newLine(p, qty = 1) {
  // Sell loose units automatically when less than one full pack is left.
  let uom = 'pack';
  if (isSale() && p.looseSale && p.trackStock !== false && p.stock > 0 && p.stock < packSizeOf(p)) uom = 'unit';
  const mult = uomMult(p, uom);
  const base = { productId: p.id, name: medTitle(p), uom, mult, unitName: uomLabel(p, uom), qty, rate: rateFor(p, uom), discount: 0 };
  if (!isSale()) Object.assign(base, { bonus: 0, batchNo: '', expiry: '', mrp: p.mrp || 0 });
  return base;
}

function addProduct(p, qty = 1) {
  if (!p) return;
  if (!p.active) { UI.toast(`"${p.name}" ${t('is inactive')}`, 'warning'); return; }
  if (isSale() && p.trackStock !== false && !st.editId) {
    const live = Catalog.batches(p.id).filter((b) => b.expiry >= today());
    if (!live.length) {
      UI.toast(p.stock > 0 ? `${p.name}: ${t('only expired stock is left')}` : `${p.name}: ${t('out of stock')}`, 'danger', 3500);
      showAlternativesIfAny(p);
      return;
    }
  }
  if (!isSale()) {
    const l = newLine(p, qty);
    st.lines.unshift(l);
    renderLines();
    if (p.trackStock !== false) editLine(0, { isNew: true });
    return;
  }
  const i = st.lines.findIndex((l) => l.productId === p.id && l.uom === (newLine(p).uom) && !l.discount && !l.batchId);
  if (i >= 0) {
    st.lines[i].qty = round3(st.lines[i].qty + qty);
    const [line] = st.lines.splice(i, 1); st.lines.unshift(line);
  } else st.lines.unshift(newLine(p, qty));
  renderLines();
  if (!(st.lines[0].rate > 0)) { UI.toast(`${p.name}: ${t('enter the price')}`, 'warning', 2500); editLine(0); return; }
  const $f = $root.find('.cart-line').first().addClass('flash');
  setTimeout(() => $f.removeClass('flash'), 900);
  const pv = preview(st.lines[0]);
  if (pv.short > 0 && !st.editId) UI.toast(`${t('Only')} ${stockText(p, pv.chunks.reduce((s, c) => s + c.base, 0))} ${t('available for')} ${p.name}`, 'warning', 2800);
  if (p.storage === 'fridge') UI.toast(`${p.name}: ${t('keep in fridge')}`, 'info', 1800);
}

function showAlternativesIfAny(p) {
  if (Catalog.alternatives(p).length) showAlternatives(p, (x) => addProduct(x));
}

function addByCode(code) {
  const p = Catalog.findByCode(code);
  if (p) { UI.beep(); addProduct(p); return true; }
  UI.toast(`${t('No medicine found for')} "${code}"`, 'warning');
  return false;
}

function hideResults() { $root.find('.search-results').addClass('d-none').empty(); }

let results = [];
const doSearch = debounce(() => {
  const q = $root.find('.pos-q').val().trim();
  if (!q) return hideResults();
  results = Catalog.searchProducts(q, { limit: 25 });
  $root.find('.search-results').removeClass('d-none').html(results.length ? results.map((p, i) => {
    const near = Catalog.batches(p.id).find((b) => b.expiry >= today());
    const unavailable = p.trackStock !== false && !near;
    return `<button class="list-row ${i === 0 ? 'bg-body-secondary' : ''}" data-i="${i}">
      <div class="main"><div class="title">${esc(medTitle(p))}</div><div class="sub">${esc(medSub(p) || [p.sku, p.barcode].filter(Boolean).join(' · '))}</div>
        <div class="d-flex flex-wrap gap-1 mt-1">${clsBadge(p)}${fridgeBadge(p)}${near ? expiryChip(near.expiry) : ''}${p.rack ? `<span class="cls-badge cls-general"><i class="bi bi-geo-alt"></i>${esc(p.rack)}</span>` : ''}</div></div>
      <div class="end"><div class="fw-bold money">${fmtNum(isSale() ? unitPrice(p, 'pack', st.priceMode) : p.purchasePrice)}</div>${stockPill(p)}
        ${unavailable && isSale() && Catalog.alternatives(p).length ? `<div><span class="badge text-bg-primary btn-res-alt" data-i="${i}">${t('Alternatives')}</span></div>` : ''}</div>
    </button>`;
  }).join('') : `<div class="p-3 small text-body-secondary">${t('No medicine matches')} "${esc(q)}".
    <div class="d-flex flex-wrap gap-2 mt-2">${Auth.can('demand.manage') ? `<a href="#" class="btn btn-sm btn-outline-primary asked-link"><i class="bi bi-clipboard2-plus me-1"></i>${t('Customer asked — not available')}</a>` : ''}
    ${Auth.can('product.edit') ? `<a href="#" class="btn btn-sm btn-primary quick-add-link"><i class="bi bi-plus-lg me-1"></i>${t('Add new medicine')}</a>` : ''}</div></div>`);
}, 120);

const dirList = () => `<datalist id="dir-list">${DIRECTIONS.map(([e, u]) => `<option value="${esc(e)}">${esc(u)}</option>`).join('')}</datalist>`;

// Edit one cart line. Purchases use this to capture batch, expiry, bonus and MRP.
async function editLine(i, { isNew = false } = {}) {
  const l = st.lines[i];
  const p = Catalog.product(l.productId);
  const sale = isSale();
  const uoms = p ? uomsOf(p, { purchase: !sale }) : [];
  const batches = p ? Catalog.batches(p.id).filter((b) => b.expiry >= (st.date || today())) : [];
  const r = await UI.formModal({
    title: p ? medTitle(p) : l.name, submitLabel: isNew ? t('Add') : t('Update'),
    body: `<div class="row g-2">
      <div class="col-5"><label class="form-label">${t('Quantity')}</label><input name="qty" class="form-control form-control-lg" inputmode="decimal" value="${l.qty}"></div>
      <div class="col-7"><label class="form-label">${t('Unit')}</label><select name="uom" class="form-select form-select-lg">${uoms.map((u) => `<option value="${u.key}" ${u.key === l.uom ? 'selected' : ''}>${esc(t(u.label))}</option>`).join('')}</select></div>
      <div class="col-6"><label class="form-label">${sale ? t('Price per unit') : t('Cost per unit')}</label><input name="rate" class="form-control form-control-lg" inputmode="decimal" value="${l.rate}"></div>
      <div class="col-6"><label class="form-label">${t('Discount (Rs)')}</label><input name="discount" class="form-control form-control-lg" inputmode="decimal" value="${l.discount || ''}" placeholder="0"></div>
      ${sale ? `
        <div class="col-12"><label class="form-label">${t('Batch')}</label><select name="batchId" class="form-select"><option value="">${t('Automatic (earliest expiry first)')}</option>${batches.map((b) => `<option value="${esc(b.id)}" ${b.id === l.batchId ? 'selected' : ''}>${esc(b.batchNo)} · ${fmtExpiry(b.expiry)} · ${esc(stockText(p, b.qty))}</option>`).join('')}</select></div>
        <div class="col-12"><label class="form-label">${t('Directions for patient')}</label><input name="dir" class="form-control" list="dir-list" maxlength="120" value="${esc(l.dir || '')}" placeholder="${t('e.g. 1+0+1 after meal')}">${dirList()}</div>`
    : `<div class="col-6"><label class="form-label">${t('Batch no.')} *</label><input name="batchNo" class="form-control form-control-lg text-uppercase" maxlength="40" value="${esc(l.batchNo || '')}"></div>
        <div class="col-6"><label class="form-label">${t('Expiry (MM/YY)')} *</label><input name="expiry" class="form-control form-control-lg" inputmode="numeric" maxlength="7" value="${l.expiry ? esc(fmtExpiry(parseExpiry(l.expiry)).replace(/\/(\d\d)(\d\d)$/, '/$2')) : ''}" placeholder="05/27"></div>
        <div class="col-6"><label class="form-label">${t('Bonus (free) quantity')}</label><input name="bonus" class="form-control" inputmode="decimal" value="${l.bonus || ''}" placeholder="0"></div>
        <div class="col-6"><label class="form-label">MRP (${t('per pack')})</label><input name="mrp" class="form-control" inputmode="decimal" value="${l.mrp || ''}"></div>`}
      ${p ? `<div class="col-12 small text-body-secondary">MRP ${fmtNum(p.mrp)} · ${t('Sale price')} ${fmtNum(p.salePrice)} · ${t('Cost price')} ${fmtNum(p.purchasePrice)}${p.trackStock !== false ? ` · ${t('Stock')} ${esc(stockText(p, p.stock))}` : ''}</div>` : ''}
      <div class="col-12"><button type="button" class="btn btn-outline-danger w-100 btn-remove-line"><i class="bi bi-trash me-1"></i>${t('Remove item')}</button></div></div>`,
    onShown: ($m) => {
      $m.find('[name=qty]').trigger('select');
      $m.find('.btn-remove-line').on('click', () => { st.lines.splice(i, 1); renderLines(); $m.find('[data-bs-dismiss=modal]').first().trigger('click'); });
      $m.on('change', '[name=uom]', function () {
        const k = this.value; $m.find('[name=rate]').val(p ? rateFor(p, k) : l.rate);
      });
      $m.on('input', '[name=expiry]', function () {
        const d = this.value.replace(/[^\d]/g, '').slice(0, 4);
        this.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
      });
    },
    onSubmit: (v) => {
      const qty = round3(num(v.qty)); const rate = round2(num(v.rate)); const discount = round2(num(v.discount));
      if (!(qty > 0)) throw new AppError(t('Quantity must be greater than zero.'));
      if (rate < 0) throw new AppError(t('Rate cannot be negative.'));
      if (discount < 0 || discount > qty * rate) throw new AppError(t('Discount must be between 0 and the line amount.'));
      const out = { qty, rate, discount, uom: v.uom, mult: p ? uomMult(p, v.uom) : l.mult, unitName: p ? uomLabel(p, v.uom) : l.unitName };
      if (sale) Object.assign(out, { batchId: v.batchId || '', dir: v.dir || '' });
      else {
        const needBatch = !p || p.trackStock !== false;
        if (needBatch) {
          if (!v.batchNo.trim()) throw new AppError(t('Enter the batch number (printed on the pack).'));
          const ex = parseExpiry(v.expiry);
          if (!ex) throw new AppError(t('Enter the expiry date as month/year, for example 05/27.'));
          if (ex < today()) throw new AppError(t('This batch is already expired.'));
        }
        Object.assign(out, { batchNo: v.batchNo.trim().toUpperCase(), expiry: v.expiry, bonus: round3(Math.max(0, num(v.bonus))), mrp: round2(num(v.mrp)) });
      }
      return out;
    },
  });
  if (r && st.lines[i] === l) { Object.assign(l, r); renderLines(); }
  else if (!r && isNew && st.lines[i] === l && !l.batchNo) { st.lines.splice(i, 1); renderLines(); }
}

async function choosePartyFn() {
  const kind = isSale() ? 'customers' : 'suppliers';
  const p = await partyPicker(kind, { noneLabel: isSale() ? t('Walk-in Customer') : t('No supplier (cash purchase)') });
  if (p === undefined) return;
  st.partyId = p?.id || null; st.partyName = p?.name || '';
  renderTotals();
}

async function loadPayAccounts() {
  payAccounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active).sort((a, b) => (a.id === 'cash' ? -1 : b.id === 'cash' ? 1 : a.name.localeCompare(b.name)));
}

// ---------- checkout ----------
function cartClasses() {
  const set = new Set();
  for (const l of st.lines) { const p = Catalog.product(l.productId); if (p) set.add(p.drugClass || 'otc'); }
  return set;
}

async function checkout() {
  const tt = Posting.previewDoc(st.lines, 0, 0);
  if (!tt) { UI.toast(t('Please fix invalid quantities/rates in the cart.'), 'warning'); return; }
  if (!st.lines.length) return;
  const sale = isSale();
  const s = getSettings();
  if (sale && !st.editId) {
    const bad = st.lines.findIndex((l) => preview(l).short > 0);
    if (bad >= 0) { UI.toast(`${st.lines[bad].name}: ${t('not enough in-date stock. Reduce the quantity or remove it.')}`, 'danger', 4500); return; }
  }
  if (!sale) {
    const bad = st.lines.findIndex((l) => { const p = Catalog.product(l.productId); return (!p || p.trackStock !== false) && (!l.batchNo || !parseExpiry(l.expiry)); });
    if (bad >= 0) { UI.toast(t('Enter batch number and expiry for every medicine.'), 'warning', 3500); editLine(bad); return; }
  }
  const classes = cartClasses();
  const hasControlled = classes.has('controlled');
  const hasRx = classes.has('rx') || hasControlled;
  const rxRequired = sale && (hasControlled || (hasRx && s.rxRequireDetails));
  const canDate = Auth.can(sale ? 'sale.edit' : 'purchase.manage');
  const lastAcc = pref.get('payAccount', 'cash');
  const m = UI.modal({
    title: sale ? t('Payment') : t('Save purchase'), static: true,
    body: `<form class="checkout" autocomplete="off">
      <div class="text-center mb-2"><div class="small text-body-secondary">${t('Amount due')}</div><div class="checkout-total money co-total"></div></div>
      <button type="button" class="btn btn-light w-100 mb-3 text-start co-party"><i class="bi bi-person me-2"></i><span></span><i class="bi bi-chevron-right float-end"></i></button>
      ${sale && hasRx ? `<div class="card border-${hasControlled ? 'danger' : 'primary'}-subtle mb-3"><div class="card-body py-2">
        <div class="fw-bold mb-2 text-${hasControlled ? 'danger' : 'primary'}"><i class="bi bi-prescription2 me-1"></i>${hasControlled ? t('Controlled medicine — prescription details are required') : t('Prescription details')}${rxRequired ? ' *' : ''}</div>
        <div class="row g-2">
          <div class="col-6"><input name="rx_patient" class="form-control" placeholder="${t('Patient name')}${rxRequired ? ' *' : ''}" value="${esc(st.rx.patient || st.partyName || '')}"></div>
          <div class="col-6"><input name="rx_doctor" class="form-control" placeholder="${t('Doctor name')}${rxRequired ? ' *' : ''}" value="${esc(st.rx.doctor)}"></div>
          <div class="col-6"><input name="rx_phone" class="form-control" inputmode="tel" placeholder="${t('Patient phone')}" value="${esc(st.rx.phone)}"></div>
          <div class="col-6"><input name="rx_note" class="form-control" placeholder="${t('Prescription no. / note')}" value="${esc(st.rx.note)}"></div>
        </div></div></div>` : ''}
      <div class="row g-2 mb-2">
        <div class="col-6"><label class="form-label">${t('Bill discount')}</label><input name="discount" class="form-control" inputmode="decimal" value="${st.discount || ''}" placeholder="0"></div>
        <div class="col-6"><label class="form-label">${t('Pay via')}</label><select name="account" class="form-select">${UI.options(payAccounts, st.payAccount || lastAcc)}</select></div>
        ${sale ? `<div class="col-12 d-flex flex-wrap gap-2 disc-chips">${[5, 10, 15, 20].map((p) => `<button type="button" class="btn btn-sm btn-outline-secondary" data-pct="${p}">${p}% ${t('off')}</button>`).join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-pct="0">${t('No discount')}</button></div>` : ''}
      </div>
      <div class="small text-body-secondary co-breakdown mb-2"></div>
      <label class="form-label">${sale ? t('Amount received') : t('Amount paid')}</label>
      <input name="tendered" class="form-control form-control-lg mb-2 money" inputmode="decimal" placeholder="0">
      <div class="d-flex flex-wrap gap-2 pay-quick mb-2"></div>
      <div class="alert py-2 mb-2 co-result"></div>
      ${!sale ? `<div class="mb-2"><label class="form-label">${t('Supplier invoice no.')}</label><input name="refNo" class="form-control" value="${esc(st.refNo)}"></div>` : ''}
      <div class="row g-2">
        ${canDate ? `<div class="col-6"><label class="form-label">${t('Date')}</label><input type="date" name="date" class="form-control" value="${esc(st.date)}" max="${today()}"></div>` : ''}
        <div class="${canDate ? 'col-6' : 'col-12'}"><label class="form-label">${t('Note')}</label><input name="note" class="form-control" value="${esc(st.note)}"></div>
      </div>
      ${sale ? `<div class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" id="co-print" ${s.printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="co-print">${t('Print receipt')}</label></div>` : ''}
      <div class="alert alert-danger py-2 small d-none co-error mt-2 mb-0"></div>
    </form>`,
    footer: `<button class="btn btn-light" data-bs-dismiss="modal">${t('Back')}</button><button class="btn btn-success btn-lg flex-grow-1 co-complete"><i class="bi bi-check2-circle me-1"></i>${sale ? t('Complete sale') : t('Save purchase')}</button>`,
  });
  const $m = m.$el;
  let tenderedTouched = st.tendered !== null && st.editId;
  const calc = () => Posting.previewDoc(st.lines, num($m.find('[name=discount]').val()), taxRate());
  const update = () => {
    const c = calc();
    $m.find('.co-party span').text(st.partyName || (sale ? t('Walk-in Customer') : t('No supplier (cash purchase)')));
    if (!c) { $m.find('.co-total').text('—'); $m.find('.co-result').attr('class', 'alert alert-danger py-2 mb-2 co-result').text(t('Discount cannot exceed the subtotal.')); $m.find('.co-complete').prop('disabled', true); return; }
    $m.find('.co-total').text(`${cur()} ${fmtNum(c.total)}`);
    $m.find('.co-breakdown').text(`${t('Subtotal')} ${fmtNum(c.subtotal)}${c.discount ? ` − ${t('discount')} ${fmtNum(c.discount)}` : ''}${c.tax ? ` + ${t('tax')} ${fmtNum(c.tax)} (${c.taxRate}%)` : ''}`);
    const $tin = $m.find('[name=tendered]');
    if (!tenderedTouched) $tin.val(st.partyId ? (st.tendered ?? '') : c.total);
    const tendered = num($tin.val());
    const diff = round2(tendered - c.total);
    let cls = 'success'; let msg;
    if (diff >= 0) msg = sale ? `${t('Change')}: <b>${cur()} ${fmtNum(diff)}</b>` : (diff > 0 ? `<b>${t('Paid amount exceeds total')}</b>` : t('Fully paid'));
    else if (st.partyId) { cls = 'warning'; msg = `${sale ? t('Balance due (udhaar)') : t('Payable')}: <b>${cur()} ${fmtNum(-diff)}</b> (${sale ? t('added to customer account') : t('added to supplier account')})`; }
    else { cls = 'danger'; msg = `${t('Short by')} ${cur()} ${fmtNum(-diff)}. ${sale ? t('Select a customer for credit (udhaar).') : t('Select a supplier for credit.')}`; }
    if (!sale && diff > 0) cls = 'danger';
    $m.find('.co-result').attr('class', `alert alert-${cls} py-2 mb-2 co-result`).html(msg);
    $m.find('.co-complete').prop('disabled', cls === 'danger');
    const quick = new Set([c.total]);
    if (sale) [10, 50, 100, 500, 1000, 5000].forEach((u) => { const v = Math.ceil(c.total / u) * u; if (v > c.total && quick.size < 5) quick.add(v); });
    $m.find('.pay-quick').html([...quick].map((v, i) => `<button type="button" class="btn btn-outline-primary" data-v="${v}">${i === 0 ? t('Exact') : fmtNum(v)}</button>`).join('')
      + (st.partyId ? `<button type="button" class="btn btn-outline-secondary" data-v="0">${sale ? t('Udhaar (credit)') : t('Unpaid')}</button>` : ''));
  };
  $m.on('input', '[name=discount]', update);
  $m.on('input', '[name=tendered]', () => { tenderedTouched = true; update(); });
  $m.on('click', '.pay-quick [data-v]', function () { tenderedTouched = true; $m.find('[name=tendered]').val(this.dataset.v); update(); });
  $m.on('click', '.disc-chips [data-pct]', function () {
    const base = Posting.previewDoc(st.lines, 0, 0)?.subtotal || 0;
    $m.find('[name=discount]').val(this.dataset.pct === '0' ? '' : round2(base * num(this.dataset.pct) / 100)); update();
  });
  $m.on('click', '.co-party', async () => {
    m.bs.hide(); await new Promise((r) => $m.one('hidden.bs.modal', r));
    await choosePartyFn(); m.bs.show(); tenderedTouched = false;
    const $rp = $m.find('[name=rx_patient]'); if ($rp.length && !$rp.val()) $rp.val(st.partyName || '');
    update();
  });
  // Our modal helper removes the element on hide; keep it alive while choosing a party.
  $m.off('hidden.bs.modal');
  let finished = false;
  const closeAll = () => { finished = true; m.bs.hide(); $m.one('hidden.bs.modal', () => { m.bs.dispose(); $m.remove(); }); };
  $m.find('[data-bs-dismiss=modal]').on('click', (e) => { e.preventDefault(); closeAll(); });
  $m.find('.btn-close').on('click', (e) => { e.preventDefault(); closeAll(); });
  $m.on('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAll(); } });
  $m.find('form').on('submit', (e) => { e.preventDefault(); $m.find('.co-complete').trigger('click'); });
  $m.on('shown.bs.modal', () => { if (!finished) $m.find('[name=tendered]').trigger('select'); });

  let busy = false;
  $m.find('.co-complete').on('click', async function () {
    if (busy) return; busy = true;
    const $b = $(this).prop('disabled', true).html(`<span class="spinner-border spinner-border-sm me-2"></span>${t('Saving…')}`);
    $m.find('.co-error').addClass('d-none');
    try {
      const account = $m.find('[name=account]').val();
      pref.set('payAccount', account);
      st.discount = num($m.find('[name=discount]').val());
      st.note = $m.find('[name=note]').val() || '';
      if (canDate) st.date = $m.find('[name=date]').val() || today();
      if (!sale) st.refNo = $m.find('[name=refNo]').val() || '';
      if (sale && hasRx) st.rx = { patient: $m.find('[name=rx_patient]').val() || '', doctor: $m.find('[name=rx_doctor]').val() || '', phone: $m.find('[name=rx_phone]').val() || '', note: $m.find('[name=rx_note]').val() || '' };
      const input = {
        id: st.id, editId: st.editId, date: st.date, items: st.lines, discount: st.discount, taxRate: taxRate(),
        tendered: num($m.find('[name=tendered]').val()), paymentAccountId: account, note: st.note, refNo: st.refNo, rx: sale && hasRx ? st.rx : null,
        customerId: sale ? st.partyId : undefined, supplierId: sale ? undefined : st.partyId,
      };
      const { doc, duplicate } = sale ? await Posting.saveSale(input) : await Posting.savePurchase(input);
      const doPrint = sale && $m.find('#co-print').prop('checked');
      closeAll();
      const wasEdit = !!st.editId;
      localStorage.removeItem(draftKey());
      st = fresh(st.mode);
      if (wasEdit) { location.hash = `#/${sale ? 'sales' : 'purchases'}/${doc.id}`; UI.toast(`${doc.number} ${t('updated')}`); return; }
      $root.html(layout()); renderLines(); renderHoldCount(); renderGrid();
      if (duplicate) UI.toast(`${doc.number} ${t('was already saved')}`);
      if (doPrint) await Printer.printDocument('sale', doc, { silentFail: true });
      afterSave(doc);
    } catch (err) {
      console.warn(err);
      $m.find('.co-error').text(err.message || String(err)).removeClass('d-none');
      $b.prop('disabled', false).html(`<i class="bi bi-check2-circle me-1"></i>${sale ? t('Complete sale') : t('Save purchase')}`);
    } finally { busy = false; }
  });
  update();
}

const confettiHTML = () => Array.from({ length: 16 }, (_, i) => {
  const icons = ['capsule', 'capsule-pill', 'plus-lg', 'heart-pulse'];
  const colors = ['#10b981', '#0891b2', '#f59e0b', '#ec4899', '#6366f1'];
  return `<i class="bi bi-${icons[i % 4]} confetti" style="left:${5 + Math.random() * 90}%;color:${colors[i % 5]};--dx:${Math.round((Math.random() - .5) * 120)}px;--rot:${Math.round(Math.random() * 720 - 360)}deg;animation-delay:${(Math.random() * .5).toFixed(2)}s"></i>`;
}).join('');

function afterSave(doc) {
  const sale = isSale();
  UI.beep();
  const m = UI.modal({
    title: sale ? t('Sale completed') : t('Purchase saved'), fullscreenMobile: false, scrollable: false,
    body: `<div class="success-wrap">${confettiHTML()}
      <svg class="check-anim" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46"/><path d="M28 52 l15 15 l29 -33"/></svg>
      <div class="h5 mt-2 mb-0">${esc(doc.number)}</div><div class="text-body-secondary fs-5 money">${cur()} ${fmtNum(doc.total)}</div>
      ${doc.change ? `<div class="alert alert-success mt-3 mb-0 py-2 fs-5">${t('Change')}: <b>${cur()} ${fmtNum(doc.change)}</b></div>` : ''}
      ${doc.balance ? `<div class="alert alert-warning mt-3 mb-0 py-2">${t('Balance due (udhaar)')}: <b>${cur()} ${fmtNum(doc.balance)}</b></div>` : ''}</div>`,
    footer: `<button class="btn btn-outline-secondary btn-print"><i class="bi bi-printer me-1"></i>${t('Print')}</button>
      <a class="btn btn-outline-secondary" href="#/${sale ? 'sales' : 'purchases'}/${doc.id}"><i class="bi bi-eye me-1"></i>${t('View')}</a>
      <button class="btn btn-primary flex-grow-1" data-bs-dismiss="modal">${sale ? t('New sale') : t('New purchase')}</button>`,
  });
  m.$el.find('.btn-print').on('click', () => Printer.printDocument(sale ? 'sale' : 'purchase', doc));
  m.$el.find('a').on('click', () => m.close());
  m.closed.then(() => $root?.find('.pos-q').trigger('focus'));
}

// ---------- holds ----------
async function holdSale() {
  if (!st.lines.length) return UI.toast(t('Cart is empty'), 'warning');
  await Posting.saveHold({ id: uuid(), label: st.partyName || `${t('Sale')} ${new Date().toLocaleTimeString()}`, state: { ...st }, total: totals().total });
  localStorage.removeItem(draftKey());
  st = fresh('sale');
  renderLines(); renderHoldCount();
  UI.toast(t('Sale held'));
}
async function showHolds() {
  const holds = (await idb.getAll('holds')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!holds.length) return UI.toast(t('No held sales'), 'info');
  const picked = await UI.pick({ title: t('Held sales'), search: async (q) => holds.filter((h) => h.label.toLowerCase().includes(q.toLowerCase())).map((h) => ({ id: h.id, title: h.label, subtitle: `${h.state.lines.length} ${t('item(s)')} · ${new Date(h.createdAt).toLocaleString()}`, right: fmtNum(h.total), value: h })) });
  if (!picked) return;
  if (st.lines.length && !await UI.confirmDialog(t('Replace the current cart with the held sale? (Hold the current cart first if you need it.)'))) return;
  st = { ...fresh('sale'), ...picked.value.state, id: uuid(), editId: null };
  await Posting.deleteHold(picked.id);
  renderLines(); renderHoldCount();
}

// ---------- quick add ----------
async function quickAdd(prefill = '') {
  if (!Auth.can('product.edit')) return UI.toast(t('You do not have permission to add medicines'), 'warning');
  const p = await editProduct(null, /^\d{6,}$/.test(prefill) ? { barcode: prefill } : { name: prefill });
  if (p) { addProduct(Catalog.product(p.id)); $root.find('.pos-q').val(''); hideResults(); }
}
async function customerAsked(name = '') {
  const { addCustomerRequest } = await import('../services/demand.js');
  await addCustomerRequest(name);
  $root.find('.pos-q').val(''); hideResults();
}
const editProduct = async (...a) => (await import('./products.js')).editProduct(...a);

// ---------- module ----------
export default {
  async render(el, { route, params, setTitle }) {
    const mode = route === 'purchase' ? 'purchase' : 'sale';
    await loadPayAccounts();
    if (params[0] === 'edit' && params[1]) {
      Auth.require(mode === 'sale' ? 'sale.edit' : 'purchase.manage');
      const doc = await idb.get(mode === 'sale' ? 'sales' : 'purchases', params[1]);
      if (!doc) throw new AppError('Document not found.');
      if (doc.status === 'void') throw new AppError('Voided documents cannot be edited.');
      const items = (await idb.getAllByIndex(mode === 'sale' ? 'saleItems' : 'purchaseItems', mode === 'sale' ? 'saleId' : 'purchaseId', doc.id)).sort((a, b) => a.line - b.line);
      st = { ...fresh(mode), id: doc.id, editId: doc.id, editNumber: doc.number, date: doc.date, partyId: doc.customerId || doc.supplierId || null,
        partyName: doc.customerId ? doc.customerName : doc.supplierId ? doc.supplierName : '', discount: doc.discount, note: doc.note || '', refNo: doc.refNo || '',
        tendered: mode === 'sale' ? doc.tendered : doc.paid, taxRate: doc.taxRate || 0, payAccount: doc.paymentAccountId, rx: { patient: '', doctor: '', phone: '', note: '', ...(doc.rx || {}) },
        lines: items.map((i) => ({ productId: i.productId, name: i.name + (i.strength ? ' ' + i.strength : ''), uom: i.uom || 'pack', mult: i.mult || 1, unitName: i.unit || '', qty: i.qty, rate: i.rate, discount: i.discount,
          ...(mode === 'sale' ? { batchId: i.batchId || '', dir: i.dir || '' } : { bonus: i.bonus || 0, batchNo: i.batchNo || '', expiry: i.expiry ? fmtExpiry(i.expiry).replace(/\/(\d\d)(\d\d)$/, '/$2') : '', mrp: i.mrp || 0 }) })) };
      setTitle(`${t('Edit')} ${doc.number}`);
    } else {
      st = fresh(mode);
      try { const d = JSON.parse(localStorage.getItem(storageKey('draft.' + mode)) || 'null'); if (d && d.mode === mode && !d.editId) st = { ...st, ...d }; } catch { /* ignore */ }
      if (st.date !== today()) st.date = today();
    }
    $root = $(el);
    $root.html(layout());
    renderLines(); renderHoldCount(); renderGrid();
    const $q = $root.find('.pos-q');
    if (window.matchMedia('(min-width: 992px)').matches) $q.trigger('focus');

    $root.on('input', '.pos-q', doSearch);
    $root.on('keydown', '.pos-q', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = $q.val().trim();
        if (!q) return;
        const exact = Catalog.findByCode(q);
        if (exact) { addProduct(exact); UI.beep(); }
        else { const r = Catalog.searchProducts(q, { limit: 2 }); if (r.length) addProduct(r[0]); else { UI.toast(`${t('No medicine found for')} "${q}"`, 'warning'); return; } }
        $q.val(''); hideResults();
      } else if (e.key === 'Escape') { $q.val(''); hideResults(); }
    });
    $root.on('click', '.search-results [data-i]', function (e) {
      if ($(e.target).closest('.btn-res-alt').length) { const p = results[+$(e.target).closest('.btn-res-alt').data('i')]; hideResults(); $q.val(''); showAlternatives(p, (x) => addProduct(x)); return; }
      addProduct(results[+this.dataset.i]); $q.val(''); hideResults(); $q.trigger('focus');
    });
    $root.on('click', '.quick-add-link', (e) => { e.preventDefault(); quickAdd($q.val().trim()); });
    $root.on('click', '.asked-link', (e) => { e.preventDefault(); customerAsked($q.val().trim()); });
    $(document).on('click.posres', (e) => { if (!$(e.target).closest('.pos-search').length) hideResults(); });

    $root.on('click', '.btn-inc, .btn-dec', function () {
      const i = +$(this).closest('.cart-line').data('i');
      const l = st.lines[i];
      const q = round3(l.qty + ($(this).hasClass('btn-inc') ? 1 : -1));
      if (q <= 0) st.lines.splice(i, 1); else l.qty = q;
      renderLines();
    });
    $root.on('change', '.qty-in', function () {
      const i = +$(this).closest('.cart-line').data('i');
      const q = round3(num(this.value));
      if (q > 0) st.lines[i].qty = q; else st.lines.splice(i, 1);
      renderLines();
    });
    $root.on('focus', '.qty-in', function () { this.select(); });
    $root.on('click', '.uom-seg button', function (e) {
      e.stopPropagation();
      const i = +$(this).closest('.uom-seg').data('i'); const l = st.lines[i]; const p = Catalog.product(l.productId);
      l.uom = this.dataset.u; l.mult = uomMult(p, l.uom); l.unitName = uomLabel(p, l.uom); l.rate = rateFor(p, l.uom);
      if (!isSale()) l.mrp = l.mrp || p.mrp;
      renderLines();
    });
    $root.on('click', '.btn-line-alt', function (e) { e.stopPropagation(); const l = st.lines[+this.dataset.i]; const p = Catalog.product(l.productId); showAlternatives(p, (x) => { st.lines.splice(+this.dataset.i, 1); addProduct(x); }); });
    $root.on('click keydown', '.btn-line', function (e) { if (e.type === 'keydown' && e.key !== 'Enter') return; if ($(e.target).closest('.uom-seg, .btn-line-alt').length) return; editLine(+$(this).closest('.cart-line').data('i')); });
    $root.on('click', '.btn-pay', checkout);
    $root.on('click', '.btn-party', choosePartyFn);
    $root.on('click', '.btn-clear', async () => {
      if (st.editId) { if (await UI.confirmDialog(t('Discard changes to this document?'))) history.back(); return; }
      if (st.lines.length && !await UI.confirmDialog(t('Clear all items from the cart?'), { okLabel: t('Clear'), okClass: 'btn-danger' })) return;
      st = fresh(st.mode); renderLines();
    });
    $root.on('click', '.btn-hold', holdSale);
    $root.on('click', '.btn-holds', showHolds);
    $root.on('click', '.btn-price-mode', () => {
      st.priceMode = st.priceMode === 'retail' ? 'wholesale' : 'retail'; pref.set('priceMode', st.priceMode);
      UI.toast(st.priceMode === 'wholesale' ? t('Using wholesale prices for new items') : t('Using retail prices for new items'), 'info'); renderTotals(); renderGrid();
    });
    $root.on('click', '.btn-quick-add', () => quickAdd(''));
    $root.on('click', '.btn-asked', () => customerAsked(''));
    $root.on('click', '.btn-scan', async () => { const code = await Scanner.scan(); if (code) addByCode(code); });
    $root.on('click', '.btn-scan-cont', () => Scanner.scan({ continuous: true, title: t('Continuous scan'), onCode: addByCode }));
    $root.on('click', '.btn-browse', () => { $root.find('.pos').addClass('show-browse'); renderGrid(); });
    $root.on('click', '.btn-close-browse', () => $root.find('.pos').removeClass('show-browse'));
    $root.on('input', '.browse-q', debounce(renderGrid, 150));
    $root.on('click', '.cat-chips [data-cat]', function () { browseForm = this.dataset.cat || null; renderGrid(); });
    $root.on('click', '.product-tile', function () {
      addProduct(Catalog.product(this.dataset.id));
      if (!window.matchMedia('(min-width: 992px)').matches) { UI.toast(t('Added'), 'success', 800); $root.find('.pos').removeClass('show-browse'); }
    });
    detachWedge = Scanner.attachWedge(addByCode);
    // Language change: redraw labels.
    this._lang = () => { if ($root) { $root.html(layout()); renderLines(); renderHoldCount(); renderGrid(); } };
    document.addEventListener('lang:changed', this._lang);
  },
  destroy() {
    detachWedge?.(); detachWedge = null;
    $(document).off('click.posres');
    if (this._lang) document.removeEventListener('lang:changed', this._lang);
    $root?.off(); $root = null;
  },
};
