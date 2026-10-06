// In-memory medicine/batch/party cache for instant search. IndexedDB remains the source of truth.
import * as idb from '../db/idb.js';
import { lc } from '../core/utils.js';
import { normName, packsOf } from '../core/pharma.js';

const products = new Map();
const categories = new Map();
const byBarcode = new Map();
const batchesBy = new Map(); // productId -> live batches (qty > 0) sorted by expiry
const parties = { customers: new Map(), suppliers: new Map() };

function sortBatches(list) {
  return list.sort((a, b) => a.expiry.localeCompare(b.expiry) || (a.receivedDate || '').localeCompare(b.receivedDate || ''));
}

function indexProduct(p) {
  const old = products.get(p.id);
  if (old?.barcode) byBarcode.delete(lc(old.barcode));
  products.set(p.id, p);
  if (p.barcode) byBarcode.set(lc(p.barcode), p);
  p._s = lc([p.name, p.urduName, p.generic, p.strength, p.company, p.form, p.sku, p.barcode, categories.get(p.categoryId)?.name].filter(Boolean).join(' '));
}

export async function load() {
  const [ps, cs, cus, sups, bs] = await idb.read(['products', 'categories', 'customers', 'suppliers', 'batches'], (t) =>
    Promise.all([t.getAll('products'), t.getAll('categories'), t.getAll('customers'), t.getAll('suppliers'), t.getAll('batches')]));
  products.clear(); categories.clear(); byBarcode.clear(); batchesBy.clear(); parties.customers.clear(); parties.suppliers.clear();
  cs.forEach((c) => categories.set(c.id, c));
  ps.forEach(indexProduct);
  for (const b of bs) if (b.qty > 0.0005) { if (!batchesBy.has(b.productId)) batchesBy.set(b.productId, []); batchesBy.get(b.productId).push(b); }
  for (const list of batchesBy.values()) sortBatches(list);
  cus.forEach((c) => parties.customers.set(c.id, c));
  sups.forEach((s) => parties.suppliers.set(s.id, s));
}

export async function refreshProducts(ids) {
  const [fresh, batches] = await idb.read(['products', 'batches'], (t) => Promise.all([
    Promise.all(ids.map((id) => t.get('products', id))),
    Promise.all(ids.map((id) => t.getAllByIndex('batches', 'productId', id))),
  ]));
  ids.forEach((id, i) => {
    if (fresh[i]) indexProduct(fresh[i]);
    else { const old = products.get(id); if (old?.barcode) byBarcode.delete(lc(old.barcode)); products.delete(id); }
    const live = batches[i].filter((b) => b.qty > 0.0005);
    if (live.length) batchesBy.set(id, sortBatches(live)); else batchesBy.delete(id);
  });
}
export async function refreshCategories() {
  const cs = await idb.getAll('categories');
  categories.clear(); cs.forEach((c) => categories.set(c.id, c));
  products.forEach(indexProduct);
}
export async function refreshParty(kind, id) {
  const p = await idb.get(kind, id);
  if (p) parties[kind].set(id, p); else parties[kind].delete(id);
}

export const product = (id) => products.get(id);
export const allProducts = () => [...products.values()];
export const category = (id) => categories.get(id);
export const allCategories = () => [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
export const party = (kind, id) => parties[kind].get(id);
export const allParties = (kind) => [...parties[kind].values()];

// Live batches of a product (qty > 0), earliest expiry first.
export const batches = (productId) => batchesBy.get(productId) || [];
export function allBatches() { const out = []; for (const list of batchesBy.values()) out.push(...list); return out; }
export const nearestExpiry = (productId) => batchesBy.get(productId)?.[0]?.expiry || null;
export const companies = () => [...new Set(allProducts().map((p) => p.company).filter(Boolean))].sort();

export function findByCode(code) {
  const c = lc(code);
  if (!c) return null;
  const p = byBarcode.get(c);
  if (p && p.active) return p;
  for (const x of products.values()) if (x.active && x.sku && lc(x.sku) === c) return x;
  return null;
}

export function searchProducts(q, { limit = 40, categoryId = null, form = null, cls = null, includeInactive = false, inStockOnly = false } = {}) {
  const terms = lc(q).split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of products.values()) {
    if (!includeInactive && !p.active) continue;
    if (categoryId && p.categoryId !== categoryId) continue;
    if (form && p.form !== form) continue;
    if (cls && p.drugClass !== cls) continue;
    if (inStockOnly && p.trackStock !== false && !(p.stock > 0)) continue;
    if (terms.every((t) => p._s.includes(t))) {
      out.push(p);
      if (!terms.length && out.length >= limit * 4) break;
    }
  }
  const q0 = lc(q);
  out.sort((a, b) => {
    const ea = (lc(a.barcode) === q0 || lc(a.sku) === q0) ? 0 : 1;
    const eb = (lc(b.barcode) === q0 || lc(b.sku) === q0) ? 0 : 1;
    const sa = lc(a.name).startsWith(q0) ? 0 : 1; const sb = lc(b.name).startsWith(q0) ? 0 : 1;
    const ia = a.stock > 0 ? 0 : 1; const ib = b.stock > 0 ? 0 : 1;
    return ea - eb || sa - sb || ia - ib || a.name.localeCompare(b.name);
  });
  return out.slice(0, limit);
}

// Same medicine (same generic/salt) from other brands: in-stock first, same strength first.
export function alternatives(p, { limit = 30 } = {}) {
  const g = normName(p.generic);
  if (!g) return [];
  const st = normName(p.strength);
  return allProducts().filter((x) => x.active && x.id !== p.id && normName(x.generic) === g)
    .sort((a, b) => {
      const ia = a.stock > 0 ? 0 : 1; const ib = b.stock > 0 ? 0 : 1;
      const sa = normName(a.strength) === st ? 0 : 1; const sb = normName(b.strength) === st ? 0 : 1;
      const fa = a.form === p.form ? 0 : 1; const fb = b.form === p.form ? 0 : 1;
      return ia - ib || sa - sb || fa - fb || (a.salePrice || 0) - (b.salePrice || 0);
    }).slice(0, limit);
}

export function searchParties(kind, q, limit = 50) {
  const terms = lc(q).split(/\s+/).filter(Boolean);
  return allParties(kind)
    .filter((p) => p.active && terms.every((t) => lc(`${p.name} ${p.phone || ''} ${p.email || ''}`).includes(t)))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

export { packsOf };
