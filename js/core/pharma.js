// Pharmacy domain helpers: medicine forms, pack/unit labels, drug classes, expiry dates and stock text.
// Stock is always stored in the smallest sellable unit (a tablet, a bottle, a vial ...). A "pack" holds
// `packSize` units (a strip of 10 tablets); a "box" holds `boxSize` packs. Prices are per pack.
import { round2, round3, today, localDate } from './utils.js';
import { t } from './i18n.js';

// form -> [pack label, unit label, default pack size, default sellable loose]
export const FORMS = {
  Tablet: ['Strip', 'Tablet', 10, true],
  Capsule: ['Strip', 'Capsule', 10, true],
  Syrup: ['Bottle', 'Bottle', 1, false],
  Suspension: ['Bottle', 'Bottle', 1, false],
  Injection: ['Ampoule', 'Ampoule', 1, false],
  'Drip / IV': ['Bottle', 'Bottle', 1, false],
  Cream: ['Tube', 'Tube', 1, false],
  Ointment: ['Tube', 'Tube', 1, false],
  Gel: ['Tube', 'Tube', 1, false],
  Drops: ['Bottle', 'Bottle', 1, false],
  Inhaler: ['Inhaler', 'Inhaler', 1, false],
  Sachet: ['Box', 'Sachet', 10, true],
  Powder: ['Packet', 'Packet', 1, false],
  Lotion: ['Bottle', 'Bottle', 1, false],
  Spray: ['Bottle', 'Bottle', 1, false],
  Suppository: ['Strip', 'Piece', 6, true],
  Surgical: ['Piece', 'Piece', 1, false],
  Other: ['Piece', 'Piece', 1, false],
};
export const FORM_LIST = Object.keys(FORMS);

export const PACK_LABELS = ['Strip', 'Box', 'Bottle', 'Ampoule', 'Vial', 'Tube', 'Sachet', 'Packet', 'Inhaler', 'Tin', 'Jar', 'Piece', 'Pair'];
export const UNIT_LABELS = ['Tablet', 'Capsule', 'Piece', 'Bottle', 'Ampoule', 'Sachet', 'Tube', 'Packet', 'Vial', 'ml'];

export const CLASSES = {
  otc: { label: 'OTC (no prescription)', short: 'OTC', icon: 'capsule', cls: 'success' },
  rx: { label: 'Prescription (Rx)', short: 'Rx', icon: 'prescription2', cls: 'primary' },
  controlled: { label: 'Controlled / Narcotic', short: 'Controlled', icon: 'shield-exclamation', cls: 'danger' },
  general: { label: 'General item (non-medicine)', short: 'General', icon: 'bag-heart', cls: 'secondary' },
};
export const STORAGE = {
  room: { label: 'Room temperature', icon: 'sun', cls: 'secondary' },
  cool: { label: 'Cool place (below 25°C)', icon: 'thermometer-low', cls: 'info' },
  fridge: { label: 'Fridge (2–8°C)', icon: 'thermometer-snow', cls: 'primary' },
};

// Common dosage directions printed on the receipt (English | Urdu).
export const DIRECTIONS = [
  ['1+0+1 after meal', 'صبح، شام کھانے کے بعد'],
  ['1+1+1 after meal', 'دن میں تین بار کھانے کے بعد'],
  ['1+0+0 morning', 'صبح ایک بار'],
  ['0+0+1 at night', 'رات کو سونے سے پہلے'],
  ['Once daily', 'دن میں ایک بار'],
  ['Twice daily', 'دن میں دو بار'],
  ['Three times daily', 'دن میں تین بار'],
  ['Every 6 hours if needed', 'ضرورت پر ہر 6 گھنٹے بعد'],
  ['Before meal', 'کھانے سے پہلے'],
  ['Apply on affected area', 'متاثرہ جگہ پر لگائیں'],
];

export const packLabel = (p) => p?.packLabel || 'Piece';
export const unitLabel = (p) => p?.unitLabel || p?.packLabel || 'Piece';
export const packSizeOf = (p) => Math.max(1, Math.floor(Number(p?.packSize) || 1));
export const boxSizeOf = (p) => Math.max(1, Math.floor(Number(p?.boxSize) || 1));
export const canSellLoose = (p) => !!p && p.looseSale === true && packSizeOf(p) > 1;
export const canBuyBox = (p) => !!p && boxSizeOf(p) > 1;

// Selling units available for a product: key -> { mult (base units), label }
export function uomsOf(p, { purchase = false } = {}) {
  const out = [];
  const ps = packSizeOf(p);
  out.push({ key: 'pack', mult: ps, label: packLabel(p) });
  if (canSellLoose(p)) out.push({ key: 'unit', mult: 1, label: unitLabel(p) });
  if (purchase && canBuyBox(p)) out.push({ key: 'box', mult: ps * boxSizeOf(p), label: 'Box' });
  return out;
}
export function uomMult(p, key) {
  const u = uomsOf(p, { purchase: true }).find((x) => x.key === key);
  return u ? u.mult : packSizeOf(p);
}
export function uomLabel(p, key) {
  const u = uomsOf(p, { purchase: true }).find((x) => x.key === key);
  return u ? u.label : packLabel(p);
}

// Default price for one selling unit.
export function unitPrice(p, key, mode = 'retail') {
  const pack = mode === 'wholesale' && p.wholesalePrice ? p.wholesalePrice : (p.salePrice || 0);
  const ps = packSizeOf(p);
  if (key === 'unit') {
    if (mode !== 'wholesale' && p.looseUnitPrice) return p.looseUnitPrice;
    return round2(pack / ps);
  }
  if (key === 'box') return round2(pack * boxSizeOf(p));
  return pack;
}

// "3 Strip + 4 Tablet"
export function stockText(p, base) {
  base = round3(base || 0);
  if (!p) return String(base);
  const ps = packSizeOf(p);
  const neg = base < 0; const a = Math.abs(base);
  const packs = Math.floor(a / ps + 1e-9);
  const rem = round3(a - packs * ps);
  const parts = [];
  if (ps === 1) return `${neg ? '-' : ''}${packs} ${t(packLabel(p))}`;
  if (packs || !rem) parts.push(`${packs} ${t(packLabel(p))}`);
  if (rem) parts.push(`${rem} ${t(unitLabel(p))}`);
  return (neg ? '-' : '') + parts.join(' + ');
}
// Stock in packs as a decimal (for min-stock comparisons and quick numbers).
export const packsOf = (p, base) => round3((base || 0) / packSizeOf(p));
// Low = finished (but it has been stocked before) or at/below the minimum you set. Never-stocked catalog items are not "low".
export const isLowStock = (p) => p.trackStock !== false && ((p.everStocked && p.stock <= 0) || ((p.minStock || 0) > 0 && packsOf(p, p.stock) <= p.minStock));

// ---------- Expiry ----------
// Medicine packs print month/year (e.g. 05/2026) and are valid to the END of that month, so we store the last day.
export function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); }

// Accepts 0526, 05/26, 5-2026, 2026-05, 2026-05-31 ... returns 'YYYY-MM-DD' (last day of month) or null.
export function parseExpiry(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m; let y;
  let r;
  if ((r = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) { y = +r[1]; m = +r[2]; }
  else if ((r = s.match(/^(\d{1,2})\s*[/\-.\s]\s*(\d{2}|\d{4})$/))) { m = +r[1]; y = +r[2]; }
  else if ((r = s.match(/^(\d{2})(\d{2})$/))) { m = +r[1]; y = +r[2]; }
  else if ((r = s.match(/^(\d{2})(\d{4})$/))) { m = +r[1]; y = +r[2]; }
  else return null;
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12) || y < 2000 || y > 2099) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`;
}
export function fmtExpiry(date) {
  if (!date) return '—';
  return `${date.slice(5, 7)}/${date.slice(0, 4)}`;
}
export function daysLeft(date, from = today()) {
  if (!date) return Infinity;
  const a = new Date(from + 'T00:00:00'); const b = new Date(date + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d);
}
// level: expired | d30 | d60 | d90 | ok
export function expiryInfo(date, from = today()) {
  const days = daysLeft(date, from);
  let level = 'ok'; let cls = 'success'; let label;
  if (days < 0) { level = 'expired'; cls = 'danger'; label = 'Expired'; }
  else if (days <= 30) { level = 'd30'; cls = 'danger'; label = days === 0 ? 'Expires today' : `${days}d left`; }
  else if (days <= 60) { level = 'd60'; cls = 'warning'; label = `${days}d left`; }
  else if (days <= 90) { level = 'd90'; cls = 'warning'; label = `${Math.round(days / 30)} months`; }
  else label = days > 730 ? `${Math.floor(days / 365)} yrs` : `${Math.round(days / 30)} months`;
  return { days, level, cls, label };
}
export const expiryChip = (date) => {
  const i = expiryInfo(date);
  return `<span class="exp-chip exp-${i.level}" title="${t(i.label)}"><i class="bi bi-calendar2-x"></i>${fmtExpiry(date)}</span>`;
};

// First-expiry-first-out allocation across batches (pure; used by the cart preview and the posting engine).
// batches: [{id, qty, expiry, receivedDate}] ; returns { chunks:[{batch, base}], short } (short = base units that could not be covered)
export function allocateFEFO(batches, base, { preferId = null, onDate = today(), allowExpired = false } = {}) {
  const usable = batches.filter((b) => b.qty > 0.0005 && (allowExpired || b.expiry >= onDate))
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || (a.receivedDate || '').localeCompare(b.receivedDate || ''));
  const pref = preferId ? usable.find((b) => b.id === preferId) : null;
  const order = pref ? [pref, ...usable.filter((b) => b !== pref)] : usable;
  const chunks = []; let left = round3(base);
  for (const b of order) {
    if (left <= 0.0005) break;
    const take = round3(Math.min(b.qty, left));
    if (take > 0) { chunks.push({ batch: b, base: take }); left = round3(left - take); }
  }
  return { chunks, short: left > 0.0005 ? left : 0 };
}

export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Medicine title as shown in lists: "Panadol 500mg Tablet"
export function medTitle(p) {
  const parts = [p.name];
  if (p.strength && !String(p.name).toLowerCase().includes(String(p.strength).toLowerCase())) parts.push(p.strength);
  return parts.join(' ');
}
export const medSub = (p) => [p.form && p.form !== 'Other' ? t(p.form) : '', p.generic, p.company].filter(Boolean).join(' · ');
export { round2 };
