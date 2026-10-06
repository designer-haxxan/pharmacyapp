// Medicines (products) & groups. Stock itself is batch-wise and changes only through purchases, sales, returns and adjustments.
import * as UI from '../core/ui.js';
import { esc, fmtNum, debounce, compressImage, uuid, num, AppError } from '../core/utils.js';
import { money, pager } from '../core/views.js';
import { t } from '../core/i18n.js';
import { FORMS, FORM_LIST, PACK_LABELS, UNIT_LABELS, CLASSES, STORAGE, DIRECTIONS, stockText, packSizeOf, packsOf, isLowStock, expiryChip, fmtExpiry, medTitle, medSub, parseExpiry, expiryInfo } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;

// Internal EAN-13 barcode in the "in-store" 20-29 prefix range.
function generateBarcode() {
  let tries = 0; let code;
  do {
    const digits = '2' + String(Math.floor(Math.random() * 10)) + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b % 10).join('');
    const sum = [...digits].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    code = digits + ((10 - (sum % 10)) % 10);
  } while (Catalog.findByCode(code) && ++tries < 20);
  return code;
}

export const clsBadge = (p) => {
  const c = CLASSES[p.drugClass || 'otc'];
  return `<span class="cls-badge cls-${p.drugClass || 'otc'}"><i class="bi bi-${c.icon}"></i>${esc(t(c.short))}</span>`;
};
export const fridgeBadge = (p) => (p.storage === 'fridge' ? `<span class="cls-badge cls-fridge"><i class="bi bi-thermometer-snow"></i>${esc(t('Fridge'))}</span>` : '');

export const stockPill = (p) => {
  if (p.trackStock === false) return `<span class="stock-pill">${esc(t('Service'))}</span>`;
  const cls = p.stock <= 0 ? 'out' : isLowStock(p) ? 'low' : 'ok';
  return `<span class="stock-pill ${cls}">${esc(p.stock <= 0 ? t('Out of stock') : stockText(p, p.stock))}</span>`;
};

const radioGroup = (name, items, current) => `<div class="d-flex flex-wrap gap-2">${items.map(([v, label, icon]) => `
  <input type="radio" class="btn-check" name="${name}" id="${name}-${v}" value="${v}" ${v === current ? 'checked' : ''}>
  <label class="btn btn-outline-primary btn-sm" for="${name}-${v}">${icon ? `<i class="bi bi-${icon} me-1"></i>` : ''}${esc(t(label))}</label>`).join('')}</div>`;

export async function editProduct(product = null, prefill = {}) {
  const p = { form: 'Tablet', packLabel: 'Strip', unitLabel: 'Tablet', packSize: 10, boxSize: 1, looseSale: true, drugClass: 'otc', storage: 'room', trackStock: true, active: 1, ...prefill, ...(product || {}) };
  let image = p.image || '';
  const cats = Catalog.allCategories();
  const companies = Catalog.companies();
  const generics = [...new Set(Catalog.allProducts().map((x) => x.generic).filter(Boolean))].sort();
  const hasStock = product && Math.abs(product.stock || 0) > 0.0005;
  const newId = uuid();
  return UI.formModal({
    title: product ? t('Edit medicine') : t('New medicine'), size: 'lg',
    body: `<div class="row g-3">
      <div class="col-12 col-md-6"><label class="form-label">${t('Medicine name')} *</label><input name="name" class="form-control form-control-lg" required maxlength="150" value="${esc(p.name)}" placeholder="${t('e.g. Panadol')}"></div>
      <div class="col-6 col-md-3"><label class="form-label">${t('Strength')}</label><input name="strength" class="form-control form-control-lg" maxlength="40" value="${esc(p.strength)}" placeholder="500mg"></div>
      <div class="col-6 col-md-3"><label class="form-label">${t('Type')}</label><select name="form" class="form-select form-select-lg">${FORM_LIST.map((f) => `<option value="${f}" ${f === p.form ? 'selected' : ''}>${esc(t(f))}</option>`).join('')}</select></div>
      <div class="col-12 col-md-6"><label class="form-label">${t('Generic / salt name')}</label><input name="generic" class="form-control" list="gen-list" maxlength="120" value="${esc(p.generic)}" placeholder="${t('e.g. Paracetamol')}"><datalist id="gen-list">${generics.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
        <div class="form-text">${t('Used to find other brands of the same medicine.')}</div></div>
      <div class="col-12 col-md-6"><label class="form-label">${t('Company')}</label><input name="company" class="form-control" list="co-list" maxlength="80" value="${esc(p.company)}" placeholder="${t('e.g. GSK')}"><datalist id="co-list">${companies.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>

      <div class="col-12"><div class="help-box"><i class="bi bi-cash-coin"></i><div>${t('Prices are for ONE PACK (one strip / bottle / box as you buy it).')}</div></div></div>
      <div class="col-4"><label class="form-label">MRP *</label><input name="mrp" class="form-control form-control-lg" inputmode="decimal" value="${p.mrp || ''}" placeholder="0"></div>
      <div class="col-4"><label class="form-label">${t('Sale price')}</label><input name="salePrice" class="form-control form-control-lg" inputmode="decimal" value="${p.salePrice || ''}" placeholder="${t('same as MRP')}"></div>
      <div class="col-4"><label class="form-label">${t('Cost price')}</label><input name="purchasePrice" class="form-control form-control-lg" inputmode="decimal" value="${p.purchasePrice || ''}" placeholder="0"></div>

      <div class="col-12"><label class="form-label">${t('Pack')}</label>
        <div class="row g-2">
          <div class="col-4"><div class="form-text mt-0 mb-1">${t('Sold as')}</div><input name="packLabel" class="form-control" list="pack-list" value="${esc(p.packLabel)}"><datalist id="pack-list">${PACK_LABELS.map((x) => `<option value="${x}">`).join('')}</datalist></div>
          <div class="col-4"><div class="form-text mt-0 mb-1">${t('Units in one pack')}</div><input name="packSize" class="form-control" inputmode="numeric" value="${p.packSize}" ${hasStock ? 'readonly' : ''}></div>
          <div class="col-4"><div class="form-text mt-0 mb-1">${t('Unit name')}</div><input name="unitLabel" class="form-control" list="unit-list" value="${esc(p.unitLabel)}"><datalist id="unit-list">${UNIT_LABELS.map((x) => `<option value="${x}">`).join('')}</datalist></div>
        </div></div>
      <div class="col-12 col-md-6 loose-f"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="looseSale" id="pr-loose" ${p.looseSale ? 'checked' : ''}><label class="form-check-label" for="pr-loose">${t('Also sell single units (loose tablets)')}</label></div>
        <input name="looseUnitPrice" class="form-control mt-2 loose-price" inputmode="decimal" value="${p.looseUnitPrice || ''}" placeholder="${t('Price of one unit (optional)')}"></div>
      <div class="col-12 col-md-6"><label class="form-label">${t('Packs in one box (for purchasing)')}</label><input name="boxSize" class="form-control" inputmode="numeric" value="${p.boxSize || 1}"></div>

      <div class="col-12"><label class="form-label">${t('Medicine class')}</label>
        ${radioGroup('drugClass', Object.entries(CLASSES).map(([k, c]) => [k, c.label, c.icon]), p.drugClass || 'otc')}
        <div class="form-text">${t('Controlled medicines always ask for the patient and doctor name when sold.')}</div></div>
      <div class="col-12"><label class="form-label">${t('Storage')}</label>
        ${radioGroup('storage', Object.entries(STORAGE).map(([k, s]) => [k, s.label, s.icon]), p.storage || 'room')}</div>
      <div class="col-6 col-md-4"><label class="form-label">${t('Tell me when packs fall below')}</label><input name="minStock" class="form-control" inputmode="decimal" value="${p.minStock || ''}" placeholder="0"></div>
      <div class="col-6 col-md-4"><label class="form-label">${t('Rack / shelf')}</label><input name="rack" class="form-control" maxlength="30" value="${esc(p.rack)}" placeholder="A-2"></div>
      <div class="col-12 col-md-4"><label class="form-label">${t('Group')}</label><select name="categoryId" class="form-select"><option value="">—</option>${UI.options(cats, p.categoryId)}</select></div>

      ${product || p.trackStock === false ? '' : `<div class="col-12"><div class="card bg-body-tertiary"><div class="card-body">
        <div class="fw-bold mb-1"><i class="bi bi-box-seam me-1"></i>${t('Stock you already have (optional)')}</div>
        <div class="row g-2">
          <div class="col-4"><label class="form-label small">${t('Batch no.')}</label><input name="ob_batch" class="form-control text-uppercase" maxlength="40" placeholder="B1234"></div>
          <div class="col-4"><label class="form-label small">${t('Expiry (MM/YY)')}</label><input name="ob_expiry" class="form-control" inputmode="numeric" maxlength="7" placeholder="05/27"></div>
          <div class="col-4"><label class="form-label small">${t('Packs')}</label><input name="ob_qty" class="form-control" inputmode="decimal" placeholder="0"></div>
        </div><div class="form-text">${t('You can add more batches later from Stock.')}</div></div></div></div>`}

      <div class="col-12"><a class="small fw-bold text-decoration-none" data-bs-toggle="collapse" href="#more-fields"><i class="bi bi-chevron-down me-1"></i>${t('More details')}</a></div>
      <div class="collapse col-12" id="more-fields"><div class="row g-3">
        <div class="col-12 col-md-6"><label class="form-label">${t('Urdu name')}</label><input name="urduName" class="form-control" dir="rtl" maxlength="150" value="${esc(p.urduName)}"></div>
        <div class="col-12 col-md-6"><label class="form-label">${t('Usual directions (printed on receipt)')}</label><input name="directions" class="form-control" list="dir-list" maxlength="120" value="${esc(p.directions)}"><datalist id="dir-list">${DIRECTIONS.map(([e, u]) => `<option value="${esc(e)}">${esc(u)}</option>`).join('')}</datalist></div>
        <div class="col-6 col-md-4"><label class="form-label">${t('Code')}</label><input name="sku" class="form-control" value="${esc(p.sku)}"></div>
        <div class="col-6 col-md-4"><label class="form-label">${t('Wholesale price')}</label><input name="wholesalePrice" class="form-control" inputmode="decimal" value="${p.wholesalePrice || ''}"></div>
        <div class="col-12 col-md-8"><label class="form-label">${t('Barcode')}</label><div class="input-group">
          <input name="barcode" class="form-control" value="${esc(p.barcode)}" inputmode="numeric">
          <button type="button" class="btn btn-outline-secondary btn-scan-bc" title="${t('Scan')}" aria-label="${t('Scan')}"><i class="bi bi-upc-scan"></i></button>
          <button type="button" class="btn btn-outline-secondary btn-gen-bc" title="${t('Generate')}" aria-label="${t('Generate')}"><i class="bi bi-magic"></i></button></div></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="trackStock" id="pr-track" ${p.trackStock !== false ? 'checked' : ''} ${hasStock ? 'disabled' : ''}><label class="form-check-label" for="pr-track">${t('Track stock (turn off for services)')}</label></div></div>
        <div class="col-12"><label class="form-label">${t('Photo')}</label><div class="d-flex align-items-center gap-2">
          <div class="thumb img-prev">${image ? `<img src="${image}" alt="" class="thumb">` : '<i class="bi bi-image"></i>'}</div>
          <input type="file" accept="image/*" class="form-control img-file"><button type="button" class="btn btn-outline-danger btn-img-rm ${image ? '' : 'd-none'}" aria-label="Remove"><i class="bi bi-x"></i></button></div></div>
        ${product ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="pr-active" ${p.active ? 'checked' : ''}><label class="form-check-label" for="pr-active">${t('Active (available for sale)')}</label></div></div>` : ''}
      </div></div>
    </div>`,
    onShown: ($m) => {
      const sync = () => { const ps = num($m.find('[name=packSize]').val(), 1); $m.find('.loose-f').toggleClass('d-none', !(ps > 1)); $m.find('.loose-price').toggleClass('d-none', !$m.find('#pr-loose').prop('checked')); };
      $m.on('input change', '[name=packSize], #pr-loose', sync); sync();
      // Choosing a type fills the pack details (only for a new medicine, or until the user edits them).
      let customised = !!product;
      $m.on('input', '[name=packLabel],[name=packSize],[name=unitLabel]', () => { customised = true; });
      $m.on('change', '[name=form]', function () {
        if (customised) return;
        const [pl, ul, ps, loose] = FORMS[this.value] || FORMS.Other;
        $m.find('[name=packLabel]').val(pl); $m.find('[name=unitLabel]').val(ul); $m.find('[name=packSize]').val(ps); $m.find('#pr-loose').prop('checked', loose); sync();
      });
      $m.on('input', '[name=ob_expiry]', function () {
        const d = this.value.replace(/[^\d]/g, '').slice(0, 4);
        this.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
      });
      $m.find('.btn-gen-bc').on('click', () => $m.find('[name=barcode]').val(generateBarcode()));
      $m.find('.btn-scan-bc').on('click', async () => {
        $m.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
        const code = await Scanner.scan();
        $m.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
        if (code) $m.find('[name=barcode]').val(code);
      });
      $m.find('.img-file').on('change', async function () {
        const f = this.files[0]; if (!f) return;
        try { image = await compressImage(f); $m.find('.img-prev').html(`<img src="${image}" alt="" class="thumb">`); $m.find('.btn-img-rm').removeClass('d-none'); } catch (e) { UI.toastError(e); }
      });
      $m.find('.btn-img-rm').on('click', function () { image = ''; $m.find('.img-prev').html('<i class="bi bi-image"></i>'); $(this).addClass('d-none'); $m.find('.img-file').val(''); });
      $m.find('[name=name]').trigger('focus');
    },
    onSubmit: async (v) => {
      if (!v.name.trim()) throw new AppError(t('Enter the medicine name.'));
      if (num(v.mrp) <= 0 && num(v.salePrice) <= 0 && !product) throw new AppError(t('Enter the MRP (price on the pack).'));
      const salePrice = num(v.salePrice) > 0 ? v.salePrice : v.mrp;
      let opening = null;
      if (!product && (v.ob_batch || v.ob_expiry || v.ob_qty)) {
        if (!v.ob_batch.trim() || !parseExpiry(v.ob_expiry) || !(num(v.ob_qty) > 0)) throw new AppError(t('To add stock now, fill the batch number, expiry date (MM/YY) and packs.'));
        opening = { batchNo: v.ob_batch.trim(), expiry: v.ob_expiry, packs: num(v.ob_qty) };
      }
      const saved = await Posting.saveProduct({ ...v, salePrice, id: product?.id, image, active: product ? v.active : true, looseSale: !!v.looseSale, trackStock: product && hasStock ? true : !!v.trackStock });
      if (opening && saved.trackStock !== false) {
        try {
          await Posting.saveAdjustment({ id: uuid(), reason: 'Opening stock', lines: [{ productId: saved.id, qty: opening.packs * packSizeOf(saved), newBatch: { batchNo: opening.batchNo, expiry: opening.expiry, mrp: saved.mrp, costPack: saved.purchasePrice } }] });
        } catch (e) { UI.toast(`${t('Medicine saved, but the stock was not added')}: ${e.message}`, 'warning', 6000); }
      }
      UI.toast(product ? t('Medicine updated') : t('Medicine added'));
      return saved;
    },
  });
}

async function manageCategories() {
  const render = () => Catalog.allCategories().map((c) => {
    const n = Catalog.allProducts().filter((p) => p.categoryId === c.id).length;
    return `<div class="list-row"><div class="main"><div class="title">${esc(c.name)}</div><div class="sub">${n} ${t('medicine(s)')}</div></div>
      <button class="btn btn-sm btn-light btn-cat-edit" data-id="${esc(c.id)}" aria-label="Rename"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-sm btn-light btn-cat-del" data-id="${esc(c.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button></div>`;
  }).join('') || UI.emptyState(t('No groups yet'), 'tags');
  const m = UI.modal({ title: t('Groups'), body: `<form class="input-group mb-3 cat-add"><input class="form-control" placeholder="${t('New group name (e.g. Baby care)')}" required><button class="btn btn-primary">${t('Add')}</button></form><div class="list-card cat-list">${render()}</div>` });
  const refresh = () => m.$el.find('.cat-list').html(render());
  m.$el.find('.cat-add').on('submit', async (e) => {
    e.preventDefault();
    const $i = $(e.target).find('input');
    try { await Posting.saveCategory({ name: $i.val() }); $i.val(''); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-edit', async function () {
    const c = Catalog.category(this.dataset.id);
    const name = prompt(t('Group name'), c.name);
    if (name === null) return;
    try { await Posting.saveCategory({ id: c.id, name }); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-del', async function () {
    try { await Posting.deleteCategory(this.dataset.id); refresh(); } catch (err) { UI.toastError(err); }
  });
  await m.closed;
}

// Same medicine (generic) from other brands.
export async function showAlternatives(p, onPick = null) {
  const list = Catalog.alternatives(p);
  const m = UI.modal({
    title: `${t('Alternatives for')} ${medTitle(p)}`, size: 'md',
    body: `<div class="small text-body-secondary mb-2">${t('Generic / salt')}: <b>${esc(p.generic || '—')}</b></div>
      <div class="list-card">${list.length ? list.map((x) => `<button class="list-row alt-row" data-id="${esc(x.id)}">
        <div class="main"><div class="title">${esc(medTitle(x))}</div><div class="sub">${esc(medSub(x))}</div></div>
        <div class="end"><div class="fw-bold money">${fmtNum(x.salePrice)}</div>${stockPill(x)}</div></button>`).join('')
        : UI.emptyState(p.generic ? t('No other brand with this generic name') : t('Add the generic name to this medicine to find alternatives'), 'search')}</div>`,
  });
  m.$el.on('click', '.alt-row', function () { const x = Catalog.product(this.dataset.id); m.close(); if (onPick) onPick(x); });
  await m.closed;
}

async function renderList(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('product.edit');
  let filter = 'all';
  const FILTERS = [['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock'], ['rx', 'Rx'], ['controlled', 'Controlled'], ['fridge', 'Fridge'], ['noprice', 'No price'], ['inactive', 'Inactive']];
  $el.html(UI.pageHeader(t('Medicines'), canEdit ? `<button class="btn btn-light btn-sm btn-cats"><i class="bi bi-tags"></i><span class="d-none d-sm-inline"> ${t('Groups')}</span></button><button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> ${t('Add medicine')}</button>` : '') + `
    <div class="filters">
      <div class="input-group flex-grow-2"><span class="input-group-text bg-body"><i class="bi bi-search"></i></span><input type="search" class="form-control q" placeholder="${t('Search name, salt, company, barcode…')}"><button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div>
    </div>
    <div class="chips mb-2 f-chips">${FILTERS.map(([k, l]) => `<span class="chip ${k === filter ? 'active' : ''}" data-f="${k}">${t(l)}</span>`).join('')}</div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="list-card list"></div>`);
  const draw = () => {
    const q = $el.find('.q').val();
    const f = filter;
    const list = Catalog.searchProducts(q, { limit: Infinity, includeInactive: true }).filter((p) => {
      if (f === 'inactive') return !p.active;
      if (!p.active) return false;
      if (f === 'low') return isLowStock(p) && p.stock > 0;
      if (f === 'out') return p.trackStock !== false && p.stock <= 0;
      if (f === 'rx') return p.drugClass === 'rx';
      if (f === 'controlled') return p.drugClass === 'controlled';
      if (f === 'fridge') return p.storage === 'fridge';
      if (f === 'noprice') return !(p.salePrice > 0);
      return true;
    });
    $el.find('.summary').text(`${list.length} ${t('medicine(s)')}`);
    pager($el.find('.list'), list, (p) => {
      const near = Catalog.nearestExpiry(p.id);
      return `<button class="list-row" data-id="${esc(p.id)}">
        ${p.image ? `<img class="thumb" src="${p.image}" alt="" loading="lazy">` : UI.avatar(p.name)}
        <div class="main"><div class="title">${esc(medTitle(p))} ${p.active ? '' : `<span class="badge text-bg-secondary">${t('Inactive')}</span>`}</div>
          <div class="sub">${esc(medSub(p) || '—')}</div>
          <div class="d-flex flex-wrap gap-1 mt-1">${clsBadge(p)}${fridgeBadge(p)}${near ? expiryChip(near) : ''}</div></div>
        <div class="end"><div class="fw-bold money">${p.salePrice > 0 ? money(p.salePrice) : `<span class="text-danger small">${t('No price')}</span>`}</div>${stockPill(p)}</div></button>`;
    }, 60, UI.emptyState(t('No medicines found'), 'capsule', canEdit ? `<div class="d-flex gap-2 justify-content-center mt-3 flex-wrap"><button class="btn btn-primary btn-add"><i class="bi bi-plus-lg me-1"></i>${t('Add medicine')}</button><button class="btn btn-outline-primary btn-starter"><i class="bi bi-magic me-1"></i>${t('Add popular Pakistani medicines')}</button></div>` : ''));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('click', '.f-chips [data-f]', function () { filter = this.dataset.f; $el.find('.f-chips .chip').removeClass('active'); $(this).addClass('active'); draw(); });
  $el.on('click', '.btn-add', async () => { if (await editProduct()) draw(); });
  $el.on('click', '.btn-starter', async () => { const { importStarterCatalog } = await import('./starter.js'); if (await importStarterCatalog()) draw(); });
  $el.on('click', '.btn-cats', async () => { await manageCategories(); renderList(el); });
  $el.on('click', '.btn-scan', async () => {
    const code = await Scanner.scan(); if (!code) return;
    const p = Catalog.findByCode(code);
    if (p) { $el.find('.q').val(code); draw(); } else if (canEdit && await UI.confirmDialog(`${t('No medicine with barcode')} ${code}. ${t('Add a new medicine?')}`)) { if (await editProduct(null, { barcode: code })) draw(); }
    else UI.toast(t('No medicine found'), 'warning');
  });
  $el.on('click', '.list-row[data-id]', function () { productActions(Catalog.product(this.dataset.id), draw); });
}

export async function productActions(p, redraw = () => {}) {
  const batches = Catalog.batches(p.id);
  const margin = p.salePrice && p.purchasePrice ? ((p.salePrice - p.purchasePrice) / p.salePrice) * 100 : null;
  const m = UI.modal({ title: medTitle(p), fullscreenMobile: false,
    body: `<div class="d-flex flex-wrap gap-1 mb-2">${clsBadge(p)}${fridgeBadge(p)}${p.rack ? `<span class="cls-badge cls-general"><i class="bi bi-geo-alt"></i>${esc(p.rack)}</span>` : ''}</div>
      <div class="small text-body-secondary mb-3">${esc(medSub(p) || '')}</div>
      <div class="row small g-2 mb-3">
        <div class="col-6">MRP: <b>${money(p.mrp)}</b></div><div class="col-6">${t('Sale price')}: <b>${money(p.salePrice)}</b></div>
        <div class="col-6">${t('Cost price')}: <b>${money(p.purchasePrice)}</b></div><div class="col-6">${t('Margin')}: <b>${margin === null ? '—' : fmtNum(margin) + '%'}</b></div>
        <div class="col-6">${t('Stock')}: <b>${p.trackStock === false ? '—' : esc(stockText(p, p.stock))}</b></div><div class="col-6">${t('Pack')}: <b>${packSizeOf(p)} ${esc(t(p.unitLabel || ''))}</b></div></div>
      ${batches.length ? `<div class="fw-bold small mb-1">${t('Batches in stock')}</div><div class="list-card mb-3">${batches.map((b) => `<div class="batch-row ${b.expiry < new Date().toISOString().slice(0, 10) ? 'is-expired' : ''}">
        <div class="flex-grow-1"><span class="bn">${esc(b.batchNo)}</span> ${expiryChip(b.expiry)}</div><div class="fw-bold">${esc(stockText(p, b.qty))}</div></div>`).join('')}</div>` : ''}
      <div class="d-grid gap-2">
        ${Auth.can('product.edit') ? `<button class="btn btn-primary btn-edit"><i class="bi bi-pencil me-1"></i>${t('Edit medicine')}</button>` : ''}
        ${p.generic ? `<button class="btn btn-outline-primary btn-alt"><i class="bi bi-arrow-left-right me-1"></i>${t('Other brands (same salt)')}</button>` : ''}
        ${Auth.can('demand.manage') ? `<button class="btn btn-outline-secondary btn-order"><i class="bi bi-clipboard2-plus me-1"></i>${t('Add to order list')}</button>` : ''}
        ${p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/${encodeURIComponent(p.id)}"><i class="bi bi-clock-history me-1"></i>${t('Stock history')}</a>` : ''}
        ${Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-sliders me-1"></i>${t('Add / adjust stock')}</a>` : ''}
        ${Auth.can('product.delete') ? `<button class="btn btn-outline-danger btn-del"><i class="bi bi-trash me-1"></i>${t('Delete')}</button>` : ''}
      </div>` });
  m.$el.find('a').on('click', () => m.close());
  m.$el.find('.btn-edit').on('click', async () => { m.close(); await m.closed; if (await editProduct(p)) redraw(); });
  m.$el.find('.btn-alt').on('click', async () => { m.close(); await m.closed; showAlternatives(p); });
  m.$el.find('.btn-order').on('click', async () => {
    const { addToOrderList } = await import('../services/demand.js');
    m.close(); await m.closed; await addToOrderList(p);
  });
  m.$el.find('.btn-del').on('click', async () => {
    m.close(); await m.closed;
    if (!await UI.confirmDialog(`${t('Delete')} "${p.name}"? ${t('Medicines with transactions are deactivated instead.')}`, { okLabel: t('Delete'), okClass: 'btn-danger' })) return;
    try { const r = await Posting.deleteProduct(p.id); UI.toast(r === 'deleted' ? t('Medicine deleted') : t('Medicine deactivated (has transactions)')); redraw(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { await renderList(el); },
};
