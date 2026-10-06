// Demand / order list logic: what to order, how many, and capturing "customer asked but we don't have it".
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, num, today, round3, localDate } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { getSettings } from '../core/settings.js';
import { packSizeOf, packsOf, isLowStock, packLabel, medTitle } from '../core/pharma.js';
import * as Catalog from './catalog.js';
import * as Posting from './posting.js';

// Units sold per day (base units) over the last `days` days, per product.
export async function salesVelocity(days = 30) {
  const from = new Date(); from.setDate(from.getDate() - days);
  const items = await idb.getAllByIndex('saleItems', 'date', IDBKeyRange.bound(localDate(from), today()));
  const map = new Map();
  for (const i of items) map.set(i.productId, (map.get(i.productId) || 0) + (i.baseQty ?? i.qty));
  for (const [k, v] of map) map.set(k, v / days);
  return map;
}

// Suggested packs to order: enough for `orderDays` of sales (or twice the minimum when there is no sales history).
export function suggestedPacks(p, velocity) {
  const have = packsOf(p, p.stock);
  const perDay = (velocity?.get(p.id) || 0) / packSizeOf(p);
  const days = getSettings().orderDays || 15;
  const target = Math.max(perDay * days, (p.minStock || 0) * 2, 1);
  return Math.max(1, Math.ceil(target - Math.max(0, have)));
}

export async function openDemands() {
  return (await idb.getAllByIndex('demands', 'status', 'open')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Low / finished medicines that are not already on the list.
export async function lowStockSuggestions() {
  const [open, velocity] = await Promise.all([openDemands(), salesVelocity(30)]);
  const onList = new Set(open.map((d) => d.productId).filter(Boolean));
  return Catalog.allProducts().filter((p) => p.active && isLowStock(p) && !onList.has(p.id))
    .map((p) => ({ product: p, qty: suggestedPacks(p, velocity), perDay: (velocity.get(p.id) || 0) }))
    .sort((a, b) => a.product.stock - b.product.stock);
}

// Ask for a quantity and put the medicine on the order list.
export async function addToOrderList(p, { source = 'manual', qty = null, note = '' } = {}) {
  const velocity = await salesVelocity(30);
  const q = qty ?? suggestedPacks(p, velocity);
  const r = await UI.formModal({
    title: t('Add to order list'), submitLabel: t('Add'),
    body: `<div class="fw-bold mb-2">${esc(medTitle(p))}</div>
      <label class="form-label">${t('How many to order?')} (${esc(t(packLabel(p)))})</label>
      <input name="qty" class="form-control form-control-lg" inputmode="numeric" value="${q}">
      <label class="form-label mt-3">${t('Note')}</label><input name="note" class="form-control" value="${esc(note)}">`,
    onSubmit: async (v) => Posting.saveDemand({ productId: p.id, name: medTitle(p), qty: Math.max(1, Math.floor(num(v.qty, 1))), note: v.note, source, supplierId: p.lastSupplierId || null, supplierName: p.lastSupplierName || '' }),
  });
  if (r) UI.toast(t('Added to order list'));
  return r;
}

// Customer asked for a medicine we do not stock: remember it so it gets ordered.
export async function addCustomerRequest(name, productId = null) {
  const r = await UI.formModal({
    title: t('Customer asked — not available'), submitLabel: t('Add to order list'),
    body: `<label class="form-label">${t('Medicine name')} *</label><input name="name" class="form-control form-control-lg" required value="${esc(name || '')}">
      <label class="form-label mt-3">${t('How many packs?')}</label><input name="qty" class="form-control" inputmode="numeric" value="1">
      <label class="form-label mt-3">${t('Note')}</label><input name="note" class="form-control" placeholder="${t('e.g. customer will come tomorrow')}">`,
    onSubmit: async (v) => Posting.saveDemand({ productId, name: v.name, qty: Math.max(1, Math.floor(num(v.qty, 1))), note: v.note, source: 'customer-asked' }),
  });
  if (r) UI.toast(t('Added to order list'));
  return r;
}

export { round3 };
