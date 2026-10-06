// Posting engine. Every business operation runs inside ONE IndexedDB transaction that writes the
// document, its lines, batch-wise stock movements, double-entry ledger entries, the number counter and the
// audit record together. If any step fails the whole transaction aborts, leaving no partial data behind.
//
// Pharmacy rules enforced here:
//  - stock lives in BATCHES (batch no. + expiry); product.stock is the sum of its batches, in base units
//  - sales take stock first-expiry-first-out (FEFO) and never from expired batches
//  - purchases must carry batch no. and expiry for every stocked medicine; bonus (free) units are supported
//  - returns, edits and voids put stock back into / take it out of the SAME batch
import * as idb from '../db/idb.js';
import { uuid, round2, round3, num, nowISO, today, AppError, clean, lc } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import { allocateFEFO, packSizeOf, parseExpiry, fmtExpiry, stockText, normName, FORMS } from '../core/pharma.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';

const EPS = 0.0005;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const NUMBER_STORE = {
  sale: 'sales', purchase: 'purchases', saleReturn: 'saleReturns', purchaseReturn: 'purchaseReturns',
  receipt: 'vouchers', payment: 'vouchers', transfer: 'vouchers', adjustment: 'adjustments',
};
export const ACCOUNT_TYPES = { cash: 'Cash', bank: 'Bank / Wallet', income: 'Income', expense: 'Expense', asset: 'Other Asset', liability: 'Liability', equity: 'Equity' };
const DEBIT_NORMAL = new Set(['cash', 'bank', 'asset', 'expense', 'customer']);
export const isDebitNormal = (type) => DEBIT_NORMAL.has(type);

export const partyAccount = (kind, id) => (kind === 'customers' ? 'C:' : 'S:') + id;
export function parseAccount(accId) {
  if (accId?.startsWith('C:')) return { kind: 'customers', id: accId.slice(2), type: 'customer' };
  if (accId?.startsWith('S:')) return { kind: 'suppliers', id: accId.slice(2), type: 'supplier' };
  return { kind: 'accounts', id: accId };
}

// ---------- helpers ----------
const newCtx = () => ({ touched: new Set(), parties: [], duplicate: false });

async function finish(ctx) {
  if (ctx.touched.size) await Catalog.refreshProducts([...ctx.touched]);
  for (const [kind, id] of ctx.parties) await Catalog.refreshParty(kind, id);
  document.dispatchEvent(new CustomEvent('data:changed'));
}

async function nextNumber(t, kind) {
  const prefix = clean(getSettings().prefixes[kind] || kind.toUpperCase(), 12);
  const key = 'seq:' + kind;
  const rec = (await t.get('meta', key)) || { key, value: 0 };
  let n = rec.value; let number;
  do { n++; number = `${prefix}-${String(n).padStart(6, '0')}`; }
  while (await t.getByIndex(NUMBER_STORE[kind], 'number', number));
  await t.put('meta', { key, value: n });
  return number;
}

function mkEntries(doc, refType, lines) {
  const at = nowISO();
  const out = lines.filter((l) => round2(l[1]) !== 0 || round2(l[2]) !== 0).map(([accountId, dr, cr, memo]) => {
    if (dr < 0 || cr < 0) throw new AppError('Internal error: negative ledger amount');
    return { id: uuid(), txnId: doc.id, refType, refNo: doc.number, date: doc.date, accountId, debit: round2(dr), credit: round2(cr), memo: memo || '', createdAt: at };
  });
  const d = round2(out.reduce((s, e) => s + e.debit, 0)); const c = round2(out.reduce((s, e) => s + e.credit, 0));
  if (Math.abs(d - c) > 0.009) throw new AppError(`Internal error: unbalanced entries (${d} / ${c})`);
  return out;
}
async function addEntries(t, doc, refType, lines) {
  for (const e of mkEntries(doc, refType, lines)) await t.add('entries', e);
}

// Move stock in/out of ONE batch (qty in base units, + in / − out). Keeps batch.qty and product.stock in step.
async function moveStock(t, ctx, { productId, batchId, qty, type, doc, cost, note = '' }) {
  const p = await t.get('products', productId);
  if (!p) throw new AppError('Medicine not found.');
  if (p.trackStock === false) return p;
  const b = batchId ? await t.get('batches', batchId) : null;
  if (!b) throw new AppError(`Batch of "${p.name}" was not found.`);
  b.qty = round3(b.qty + qty); b.updatedAt = nowISO();
  if (qty < 0 && b.qty < -EPS) throw new AppError(`Not enough stock in batch ${b.batchNo} of "${p.name}". Available: ${stockText(p, b.qty - qty)}`);
  await t.put('batches', b);
  p.stock = round3((p.stock || 0) + qty); p.updatedAt = nowISO();
  if (qty > 0) p.everStocked = true;
  await t.put('products', p);
  await t.add('stockMoves', { id: uuid(), productId, batchId: b.id, batchNo: b.batchNo, expiry: b.expiry, date: doc.date, qty: round3(qty), type, refId: doc.id, refNo: doc.number, cost: r4(cost ?? b.cost ?? 0), note, createdAt: nowISO() });
  ctx.touched.add(productId);
  return p;
}

async function createBatch(t, p, { batchNo, expiry, qtyIn, cost, mrp, srcType, srcId, srcNo, date, supplierId = null, supplierName = '' }) {
  const b = { id: uuid(), productId: p.id, batchNo: clean(batchNo, 40).toUpperCase(), expiry, qty: 0, qtyIn: round3(qtyIn), cost: r4(cost || 0), mrp: round2(mrp || p.mrp || 0),
    supplierId, supplierName, srcType, srcId, srcNo, receivedDate: date, createdAt: nowISO(), updatedAt: nowISO() };
  await t.add('batches', b);
  return b;
}

function checkBatchInput(p, batchNo, expiry, onDate) {
  const bn = clean(batchNo, 40);
  if (!bn) throw new AppError(`Enter the batch number of "${p.name}".`);
  const ex = parseExpiry(expiry);
  if (!ex) throw new AppError(`Enter a valid expiry date (MM/YY) for "${p.name}".`);
  if (ex < onDate) throw new AppError(`"${p.name}" batch ${bn} is already expired (${fmtExpiry(ex)}).`);
  return { batchNo: bn, expiry: ex };
}

// Remove all stock moves & ledger entries of a document (used by edit and void). Batches created by the document are removed too.
async function revertDoc(t, ctx, docId) {
  const moves = await t.getAllByIndex('stockMoves', 'refId', docId);
  for (const m of moves) {
    const p = await t.get('products', m.productId);
    const b = m.batchId ? await t.get('batches', m.batchId) : null;
    if (b) {
      b.qty = round3(b.qty - m.qty); b.updatedAt = nowISO();
      if (m.qty > 0 && b.qty < -EPS) throw new AppError(`Cannot reverse: stock of "${p?.name || 'medicine'}" (batch ${b.batchNo}) has already been sold or used.`);
      await t.put('batches', b);
    }
    if (p) { p.stock = round3((p.stock || 0) - m.qty); p.updatedAt = nowISO(); await t.put('products', p); ctx.touched.add(p.id); }
    await t.delete('stockMoves', m.id);
  }
  for (const b of await t.getAllByIndex('batches', 'srcId', docId)) {
    if (Math.abs(b.qty) > EPS) throw new AppError(`Cannot reverse: batch ${b.batchNo} was created by this document and its stock has already been used.`);
    ctx.touched.add(b.productId);
    await t.delete('batches', b.id);
  }
  await t.deleteByIndex('entries', 'txnId', docId);
}

async function audit(t, action, details = {}) {
  const u = Auth.user();
  const rec = { id: uuid(), at: nowISO(), userId: u?.id || null, userName: u?.name || '', action, details };
  await t.add('auditLog', rec);
}

const stamp = () => { const u = Auth.user(); return { userId: u?.id || null, userName: u?.name || '' }; };

async function paymentAccount(t, id) {
  const acc = await t.get('accounts', id || 'cash');
  if (!acc || !['cash', 'bank'].includes(acc.type) || !acc.active) throw new AppError('Select a valid cash/bank payment account.');
  return acc;
}

// ---------- document calculation (shared with the UI for live totals) ----------
export function calcDoc(items, billDiscount = 0, taxRate = 0) {
  const lines = [];
  for (const it of items) {
    const qty = round3(num(it.qty)); const rate = round2(num(it.rate)); const disc = round2(num(it.discount));
    if (!(qty > 0)) throw new AppError(`Quantity must be greater than zero (${it.name || 'item'}).`);
    if (rate < 0) throw new AppError(`Rate cannot be negative (${it.name || 'item'}).`);
    const gross = round2(qty * rate);
    if (disc < 0 || disc > gross + EPS) throw new AppError(`Invalid discount for ${it.name || 'item'}.`);
    const mult = num(it.mult) > 0 ? num(it.mult) : 1;
    lines.push({ ...it, qty, rate, discount: disc, amount: round2(gross - disc), mult, baseQty: round3(qty * mult) });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discount = round2(num(billDiscount));
  if (discount < 0 || discount > subtotal + EPS) throw new AppError('Bill discount cannot exceed the subtotal.');
  const taxable = round2(subtotal - discount);
  const tax = round2(taxable * num(taxRate) / 100);
  return { lines, subtotal, discount, taxRate: num(taxRate), tax, total: round2(taxable + tax), qtyTotal: round3(lines.reduce((s, l) => s + l.qty, 0)) };
}
// Same calculation without throwing, for live UI previews.
export function previewDoc(items, billDiscount, taxRate) {
  try { return calcDoc(items, billDiscount, taxRate); } catch { return null; }
}

// ---------- SALES ----------
const STOCK_STORES = ['products', 'batches', 'stockMoves', 'entries', 'meta', 'accounts', 'auditLog'];
const SALE_STORES = [...STOCK_STORES, 'sales', 'saleItems', 'customers', 'saleReturns'];

function sellMessage(p, batches, need, onDate) {
  const ok = batches.filter((b) => b.qty > EPS && b.expiry >= onDate).reduce((s, b) => s + b.qty, 0);
  const expired = batches.filter((b) => b.qty > EPS && b.expiry < onDate);
  const exp = expired.reduce((s, b) => s + b.qty, 0);
  let msg = `Not enough stock for "${p.name}". Needed ${stockText(p, need)}, available ${stockText(p, ok)}.`;
  if (exp > EPS) msg += ` (${stockText(p, exp)} is expired and cannot be sold.)`;
  return msg;
}

export async function saveSale(input) {
  const editing = !!input.editId;
  Auth.require(editing ? 'sale.edit' : 'sale.create');
  const id = input.editId || input.id;
  if (!id) throw new AppError('Missing sale id.');
  const calc = calcDoc(input.items, input.discount, input.taxRate);
  if (!calc.lines.length) throw new AppError('The cart is empty.');
  const customerId = input.customerId || null;
  const tendered = round2(num(input.tendered));
  if (tendered < 0) throw new AppError('Paid amount cannot be negative.');
  const paid = round2(Math.min(tendered, calc.total));
  if (!customerId && paid < calc.total - 0.001) throw new AppError('Walk-in sales must be fully paid. Select a customer to sell on credit (udhaar).');
  const ctx = newCtx();

  const sale = await idb.write(SALE_STORES, async (t) => {
    const existing = await t.get('sales', id);
    if (existing && !editing) { ctx.duplicate = true; return existing; }
    if (editing) {
      if (!existing) throw new AppError('Sale not found.');
      if (existing.status === 'void') throw new AppError('A voided sale cannot be edited.');
      if ((await t.getAllByIndex('saleReturns', 'saleId', id)).some((r) => r.status !== 'void')) throw new AppError('This sale has returns and can no longer be edited.');
      await revertDoc(t, ctx, id);
      await t.deleteByIndex('saleItems', 'saleId', id);
    }
    let customerName = 'Walk-in Customer';
    if (customerId) {
      const c = await t.get('customers', customerId);
      if (!c) throw new AppError('Customer not found.');
      customerName = c.name; ctx.parties.push(['customers', customerId]);
    }
    const acc = await paymentAccount(t, input.paymentAccountId);
    const number = existing?.number || await nextNumber(t, 'sale');
    const now = nowISO();
    const date = input.date || existing?.date || today();

    // Prescription details (required for controlled drugs).
    const rxIn = input.rx || {};
    const rx = { patient: clean(rxIn.patient, 80), doctor: clean(rxIn.doctor, 80), phone: clean(rxIn.phone, 30), note: clean(rxIn.note, 200) };
    const hasRxInfo = !!(rx.patient || rx.doctor || rx.phone || rx.note);

    const doc = {
      id, number, date, createdAt: existing?.createdAt || now, updatedAt: now,
      customerId, customerName, itemCount: 0, qtyTotal: calc.qtyTotal,
      subtotal: calc.subtotal, discount: calc.discount, taxRate: calc.taxRate, tax: calc.tax, total: calc.total,
      tendered, paid, change: round2(Math.max(0, tendered - calc.total)), balance: round2(calc.total - paid),
      paymentAccountId: acc.id, paymentAccountName: acc.name,
      paymentType: paid >= calc.total ? 'paid' : paid > 0 ? 'partial' : 'credit',
      status: 'completed', note: clean(input.note, 500), edited: editing || !!existing?.edited, ...stamp(),
    };

    let i = 0; let hasRx = false; let hasControlled = false; let profitCost = 0;
    const needRxDetails = getSettings().rxRequireDetails;
    for (const l of calc.lines) {
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('A medicine in the cart no longer exists.');
      if (!p.active && !editing) throw new AppError(`"${p.name}" is inactive.`);
      if (p.drugClass === 'controlled') hasControlled = true;
      if (p.drugClass === 'rx' || p.drugClass === 'controlled') hasRx = true;

      let chunks;
      if (p.trackStock === false) chunks = [{ batch: null, base: l.baseQty }];
      else {
        const batches = await t.getAllByIndex('batches', 'productId', p.id);
        const a = allocateFEFO(batches, l.baseQty, { preferId: l.batchId, onDate: date });
        if (a.short > 0) throw new AppError(sellMessage(p, batches, l.baseQty, date));
        chunks = a.chunks;
      }
      let remAmt = l.amount; let remDisc = l.discount;
      for (let k = 0; k < chunks.length; k++) {
        const c = chunks[k]; const last = k === chunks.length - 1;
        const amount = last ? round2(remAmt) : round2(l.amount * c.base / l.baseQty);
        const discount = last ? round2(remDisc) : round2(l.discount * c.base / l.baseQty);
        remAmt = round2(remAmt - amount); remDisc = round2(remDisc - discount);
        const whole = Math.abs(c.base / l.mult - Math.round(c.base / l.mult)) < 1e-6;
        const qty = whole ? round3(c.base / l.mult) : c.base;
        const mult = whole ? l.mult : 1;
        const cost = c.batch ? c.batch.cost : r4((p.purchasePrice || 0) / packSizeOf(p));
        const item = { id: uuid(), saleId: id, saleNo: number, date, line: i++, productId: p.id, name: p.name, strength: p.strength || '', form: p.form || '', cls: p.drugClass || 'otc',
          batchId: c.batch?.id || '', batchNo: c.batch?.batchNo || '', expiry: c.batch?.expiry || '',
          uom: whole ? (l.uom || 'pack') : 'unit', mult, unit: whole ? (l.unitName || '') : (p.unitLabel || ''), qty, baseQty: c.base,
          rate: whole ? l.rate : round2((amount + discount) / (qty || 1)), discount, amount, cost, dir: clean(l.dir, 120) };
        profitCost += cost * c.base;
        await t.add('saleItems', item);
        await moveStock(t, ctx, { productId: p.id, batchId: c.batch?.id, qty: -c.base, type: 'sale', doc, cost });
      }
    }
    doc.itemCount = i;
    doc.hasRx = hasRx; doc.hasControlled = hasControlled;
    if ((hasControlled || (hasRx && needRxDetails)) && !(rx.patient && rx.doctor)) {
      throw new AppError(hasControlled ? 'A controlled/narcotic medicine is in this sale. Enter the patient name and doctor name.' : 'Enter the patient name and doctor name for the prescription medicines.');
    }
    doc.rx = hasRxInfo ? rx : null;
    doc.costTotal = round2(profitCost);
    await t.put('sales', doc);
    const net = round2(calc.total - calc.tax);
    const C = customerId && partyAccount('customers', customerId);
    await addEntries(t, doc, 'sale', customerId ? [
      [C, calc.total, 0, 'Sale'], ['sales', 0, net, 'Sale'], ['tax', 0, calc.tax, 'Sales tax'],
      [acc.id, paid, 0, 'Payment received'], [C, 0, paid, 'Payment received'],
    ] : [[acc.id, calc.total, 0, 'Cash sale'], ['sales', 0, net, 'Sale'], ['tax', 0, calc.tax, 'Sales tax']]);
    await audit(t, editing ? 'sale_edited' : 'sale_created', { number, total: calc.total });
    return doc;
  });
  await finish(ctx);
  return { doc: sale, duplicate: ctx.duplicate };
}

// ---------- PURCHASES ----------
const PUR_STORES = [...STOCK_STORES, 'purchases', 'purchaseItems', 'suppliers', 'purchaseReturns', 'demands'];

export async function savePurchase(input) {
  Auth.require('purchase.manage');
  const editing = !!input.editId;
  const id = input.editId || input.id;
  const calc = calcDoc(input.items, input.discount, 0);
  if (!calc.lines.length) throw new AppError('Add at least one medicine.');
  const supplierId = input.supplierId || null;
  const paid = round2(num(input.tendered));
  if (paid < 0 || paid > calc.total + 0.001) throw new AppError('Paid amount must be between 0 and the total.');
  if (!supplierId && paid < calc.total - 0.001) throw new AppError('Select a supplier for credit purchases, or pay the full amount.');
  const s = getSettings();
  const ctx = newCtx();

  const pur = await idb.write(PUR_STORES, async (t) => {
    const existing = await t.get('purchases', id);
    if (existing && !editing) { ctx.duplicate = true; return existing; }
    if (editing) {
      if (!existing) throw new AppError('Purchase not found.');
      if (existing.status === 'void') throw new AppError('A voided purchase cannot be edited.');
      if ((await t.getAllByIndex('purchaseReturns', 'purchaseId', id)).some((r) => r.status !== 'void')) throw new AppError('This purchase has returns and can no longer be edited.');
      await revertDoc(t, ctx, id);
      await t.deleteByIndex('purchaseItems', 'purchaseId', id);
    }
    let supplierName = 'Cash Purchase';
    if (supplierId) {
      const sp = await t.get('suppliers', supplierId);
      if (!sp) throw new AppError('Supplier not found.');
      supplierName = sp.name; ctx.parties.push(['suppliers', supplierId]);
    }
    const acc = await paymentAccount(t, input.paymentAccountId);
    const number = existing?.number || await nextNumber(t, 'purchase');
    const now = nowISO();
    const date = input.date || existing?.date || today();
    const doc = {
      id, number, date, createdAt: existing?.createdAt || now, updatedAt: now,
      supplierId, supplierName, refNo: clean(input.refNo, 60), itemCount: calc.lines.length, qtyTotal: calc.qtyTotal,
      subtotal: calc.subtotal, discount: calc.discount, tax: 0, total: calc.total, paid, balance: round2(calc.total - paid),
      paymentAccountId: acc.id, paymentAccountName: acc.name, status: 'completed', note: clean(input.note, 500),
      edited: editing || !!existing?.edited, ...stamp(),
    };
    await t.put('purchases', doc);
    const factor = calc.subtotal > 0 ? calc.total / calc.subtotal : 1;
    let i = 0;
    for (const l of calc.lines) {
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('A medicine in this purchase no longer exists.');
      const bonus = round3(Math.max(0, num(l.bonus)));
      const baseTotal = round3((l.qty + bonus) * l.mult);
      const unitCost = r4(l.amount * factor / baseTotal);      // bonus units lower the real cost per tablet
      const tracked = p.trackStock !== false;
      let batch = null;
      if (tracked) {
        const bi = checkBatchInput(p, l.batchNo, l.expiry, date);
        batch = await createBatch(t, p, { ...bi, qtyIn: baseTotal, cost: unitCost, mrp: num(l.mrp) || p.mrp, srcType: 'purchase', srcId: id, srcNo: number, date, supplierId, supplierName });
      }
      await t.add('purchaseItems', { id: uuid(), purchaseId: id, purchaseNo: number, date, line: i++, productId: p.id, name: p.name, strength: p.strength || '',
        batchId: batch?.id || '', batchNo: batch?.batchNo || '', expiry: batch?.expiry || '', uom: l.uom || 'pack', mult: l.mult, unit: l.unitName || '',
        qty: l.qty, bonus, baseQty: baseTotal, rate: l.rate, discount: l.discount, amount: l.amount, unitCost, mrp: round2(num(l.mrp) || p.mrp || 0) });
      if (tracked) await moveStock(t, ctx, { productId: p.id, batchId: batch.id, qty: baseTotal, type: 'purchase', doc, cost: unitCost });
      // Keep the medicine card up to date with the newest prices.
      const p2 = await t.get('products', p.id);
      const newMrp = round2(num(l.mrp));
      if (s.updatePurchasePrice) p2.purchasePrice = round2(unitCost * packSizeOf(p2));
      if (newMrp > 0) {
        if (s.syncSalePrice && (!p2.salePrice || p2.salePrice === p2.mrp)) p2.salePrice = newMrp;
        p2.mrp = newMrp;
      }
      if (supplierId) { p2.lastSupplierId = supplierId; p2.lastSupplierName = supplierName; }
      p2.updatedAt = nowISO();
      await t.put('products', p2); ctx.touched.add(p.id);
      // Anything on the order list for this medicine has now arrived.
      for (const dm of await t.getAllByIndex('demands', 'productId', p.id)) {
        if (dm.status !== 'received') { dm.status = 'received'; dm.receivedAt = now; dm.updatedAt = now; await t.put('demands', dm); }
      }
    }
    const S = supplierId && partyAccount('suppliers', supplierId);
    await addEntries(t, doc, 'purchase', supplierId ? [
      ['purchases', calc.total, 0, 'Purchase'], [S, 0, calc.total, 'Purchase'],
      [S, paid, 0, 'Payment made'], [acc.id, 0, paid, 'Payment made'],
    ] : [['purchases', calc.total, 0, 'Cash purchase'], [acc.id, 0, calc.total, 'Cash purchase']]);
    await audit(t, editing ? 'purchase_edited' : 'purchase_created', { number, total: calc.total });
    return doc;
  });
  await finish(ctx);
  return { doc: pur, duplicate: ctx.duplicate };
}

// ---------- RETURNS ----------
async function returnedQtyMap(t, store, fk, docId) {
  const map = {};
  for (const r of await t.getAllByIndex(store, fk, docId)) {
    if (r.status === 'void') continue;
    for (const it of r.items) map[it.lineId] = round3((map[it.lineId] || 0) + it.qty);
  }
  return map;
}

// Returnable lines of a sale/purchase: [{...item, returned, remaining}]
export async function returnableLines(kind, docId) {
  const [itemStore, fk, retStore] = kind === 'sale' ? ['saleItems', 'saleId', 'saleReturns'] : ['purchaseItems', 'purchaseId', 'purchaseReturns'];
  return idb.read([itemStore, retStore], async (t) => {
    const items = (await t.getAllByIndex(itemStore, fk, docId)).sort((a, b) => a.line - b.line);
    const map = await returnedQtyMap(t, retStore, fk, docId);
    return items.map((it) => ({ ...it, returned: map[it.id] || 0, remaining: round3(it.qty - (map[it.id] || 0)) }));
  });
}

export async function saveReturn(kind, input) {
  const isSale = kind === 'sale';
  Auth.require(isSale ? 'sale.return' : 'purchase.manage');
  const [docStore, itemStore, retStore, fk, partyStore, partyKey] = isSale
    ? ['sales', 'saleItems', 'saleReturns', 'saleId', 'customers', 'customerId']
    : ['purchases', 'purchaseItems', 'purchaseReturns', 'purchaseId', 'suppliers', 'supplierId'];
  const ctx = newCtx();
  const ret = await idb.write([docStore, itemStore, retStore, ...STOCK_STORES], async (t) => {
    const existing = await t.get(retStore, input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const src = await t.get(docStore, input.docId);
    if (!src || src.status === 'void') throw new AppError('Original document not found or voided.');
    const items = await t.getAllByIndex(itemStore, fk, src.id);
    const done = await returnedQtyMap(t, retStore, fk, src.id);
    const factor = src.subtotal > 0 ? src.total / src.subtotal : 1;
    const lines = [];
    for (const l of input.lines) {
      const qty = round3(num(l.qty));
      if (!(qty > 0)) continue;
      const it = items.find((x) => x.id === l.lineId);
      if (!it) throw new AppError('Invalid return line.');
      const remaining = round3(it.qty - (done[it.id] || 0));
      if (qty > remaining + EPS) throw new AppError(`Cannot return ${qty} of "${it.name}" (max ${remaining}).`);
      const amount = round2(it.amount * factor * qty / it.qty);
      lines.push({ lineId: it.id, productId: it.productId, name: it.name, unit: it.unit, uom: it.uom, mult: it.mult || 1, batchId: it.batchId || '', batchNo: it.batchNo || '', expiry: it.expiry || '',
        qty, baseQty: round3(qty * (it.mult || 1)), rate: round2(amount / qty), amount, lineAmount: round2(it.amount * qty / it.qty), cost: isSale ? it.cost : it.unitCost });
    }
    if (!lines.length) throw new AppError('Enter a quantity to return.');
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    const tax = isSale && src.total > 0 ? round2(total * (src.tax || 0) / src.total) : 0;
    const partyId = src[partyKey] || null;
    let refund = partyId ? round2(num(input.refund)) : total;
    if (refund < 0 || refund > total + 0.001) throw new AppError('Refund must be between 0 and the return total.');
    const acc = await paymentAccount(t, input.refundAccountId);
    const number = await nextNumber(t, isSale ? 'saleReturn' : 'purchaseReturn');
    const doc = {
      id: input.id, number, date: input.date || today(), createdAt: nowISO(), [fk]: src.id, docNo: src.number,
      [partyKey]: partyId, partyName: isSale ? src.customerName : src.supplierName,
      items: lines, total, tax, refund, refundAccountId: acc.id, refundAccountName: acc.name,
      reason: clean(input.reason, 60), status: 'completed', note: clean(input.note, 500), ...stamp(),
    };
    await t.add(retStore, doc);
    for (const l of lines) {
      await moveStock(t, ctx, { productId: l.productId, batchId: l.batchId, qty: isSale ? l.baseQty : -l.baseQty, type: isSale ? 'sale_return' : 'purchase_return', doc, cost: l.cost });
    }
    if (partyId) ctx.parties.push([partyStore, partyId]);
    if (isSale) {
      const C = partyId ? partyAccount('customers', partyId) : acc.id;
      await addEntries(t, doc, 'saleReturn', [
        ['sales_returns', round2(total - tax), 0, 'Sales return'], ['tax', tax, 0, 'Tax reversal'], [C, 0, total, 'Sales return'],
        ...(partyId ? [[C, refund, 0, 'Refund paid'], [acc.id, 0, refund, 'Refund paid']] : []),
      ]);
    } else {
      const S = partyId ? partyAccount('suppliers', partyId) : acc.id;
      await addEntries(t, doc, 'purchaseReturn', [
        [S, total, 0, 'Purchase return'], ['purchase_returns', 0, total, 'Purchase return'],
        ...(partyId ? [[acc.id, refund, 0, 'Refund received'], [S, 0, refund, 'Refund received']] : []),
      ]);
    }
    await audit(t, isSale ? 'sale_return' : 'purchase_return', { number, total });
    return doc;
  });
  await finish(ctx);
  return { doc: ret, duplicate: ctx.duplicate };
}

// ---------- VOID ----------
const VOID_DEF = {
  sale: { store: 'sales', perm: 'sale.void', items: 'saleItems', fk: 'saleId', returns: 'saleReturns', party: ['customers', 'customerId'] },
  purchase: { store: 'purchases', perm: 'purchase.manage', items: 'purchaseItems', fk: 'purchaseId', returns: 'purchaseReturns', party: ['suppliers', 'supplierId'] },
  saleReturn: { store: 'saleReturns', perm: 'sale.void', party: ['customers', 'customerId'] },
  purchaseReturn: { store: 'purchaseReturns', perm: 'purchase.manage', party: ['suppliers', 'supplierId'] },
  voucher: { store: 'vouchers', perm: 'voucher.void' },
  adjustment: { store: 'adjustments', perm: 'stock.adjust' },
};

export async function voidDocument(kind, id, reason = '') {
  const def = VOID_DEF[kind];
  Auth.require(def.perm);
  const ctx = newCtx();
  const stores = [def.store, ...STOCK_STORES, ...(def.items ? [def.items, def.returns] : [])];
  const doc = await idb.write([...new Set(stores)], async (t) => {
    const d = await t.get(def.store, id);
    if (!d) throw new AppError('Document not found.');
    if (d.status === 'void') throw new AppError('Already voided.');
    if (def.returns) {
      const rets = (await t.getAllByIndex(def.returns, def.fk, id)).filter((r) => r.status !== 'void');
      if (rets.length) throw new AppError('Void the returns of this document first.');
    }
    await revertDoc(t, ctx, id);
    if (def.items) {
      d.voidedItems = await t.getAllByIndex(def.items, def.fk, id);
      await t.deleteByIndex(def.items, def.fk, id);
    }
    Object.assign(d, { status: 'void', voidedAt: nowISO(), voidedBy: Auth.user()?.name || '', voidReason: clean(reason, 200), updatedAt: nowISO() });
    await t.put(def.store, d);
    if (def.party && d[def.party[1]]) ctx.parties.push([def.party[0], d[def.party[1]]]);
    if (kind === 'voucher') for (const a of [d.accountId, d.counterAccountId]) { const pa = parseAccount(a); if (pa.kind !== 'accounts') ctx.parties.push([pa.kind, pa.id]); }
    await audit(t, kind + '_voided', { number: d.number });
    return d;
  });
  await finish(ctx);
  return doc;
}

// ---------- VOUCHERS (receipts, payments, transfers) ----------
async function accountInfo(t, accId) {
  const pa = parseAccount(accId);
  const rec = await t.get(pa.kind, pa.id);
  if (!rec) return null;
  return { id: accId, name: rec.name, type: pa.type || rec.type, active: rec.active };
}

export async function saveVoucher(input) {
  const type = input.type;
  if (!['receipt', 'payment', 'transfer'].includes(type)) throw new AppError('Invalid voucher type.');
  Auth.require(type === 'receipt' ? 'voucher.create' : 'account.manage');
  const amount = round2(num(input.amount));
  if (!(amount > 0)) throw new AppError('Amount must be greater than zero.');
  if (!input.counterAccountId) throw new AppError(type === 'transfer' ? 'Select the destination account.' : 'Select who/what this is for.');
  if (input.counterAccountId === input.accountId) throw new AppError('The two accounts must be different.');
  const ctx = newCtx();
  const doc = await idb.write(['vouchers', 'entries', 'meta', 'accounts', 'customers', 'suppliers', 'auditLog'], async (t) => {
    const existing = await t.get('vouchers', input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const acc = await paymentAccount(t, input.accountId);
    const counter = await accountInfo(t, input.counterAccountId);
    if (!counter || !counter.active) throw new AppError('The selected account/party does not exist or is inactive.');
    if (type === 'transfer' && !['cash', 'bank'].includes(counter.type)) throw new AppError('Transfers must be between cash/bank accounts.');
    const number = await nextNumber(t, type);
    const d = {
      id: input.id, number, type, date: input.date || today(), createdAt: nowISO(), amount,
      accountId: acc.id, accountName: acc.name, counterAccountId: counter.id, counterName: counter.name, counterType: counter.type,
      method: clean(input.method, 40), note: clean(input.note, 500), status: 'completed', ...stamp(),
    };
    await t.add('vouchers', d);
    const memo = d.note || { receipt: 'Received', payment: 'Paid', transfer: 'Transfer' }[type];
    await addEntries(t, d, type, type === 'receipt'
      ? [[acc.id, amount, 0, memo], [counter.id, 0, amount, memo]]
      : type === 'payment' ? [[counter.id, amount, 0, memo], [acc.id, 0, amount, memo]]
        : [[counter.id, amount, 0, memo], [acc.id, 0, amount, memo]]);
    const pa = parseAccount(counter.id);
    if (pa.kind !== 'accounts') ctx.parties.push([pa.kind, pa.id]);
    await audit(t, 'voucher_' + type, { number, amount });
    return d;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}

// ---------- MASTER DATA ----------
async function setOpening(t, txnId, accountId, debitAmount, date, label) {
  await t.deleteByIndex('entries', 'txnId', txnId);
  const amt = round2(debitAmount);
  if (!amt) return;
  const doc = { id: txnId, number: 'OPENING', date: date || today() };
  await addEntries(t, doc, 'opening', amt > 0 ? [[accountId, amt, 0, label], ['equity', 0, amt, label]] : [[accountId, 0, -amt, label], ['equity', -amt, 0, label]]);
}

export async function saveParty(kind, data) {
  Auth.require(kind === 'customers' ? 'party.edit' : 'purchase.manage');
  const name = clean(data.name, 120);
  if (!name) throw new AppError('Name is required.');
  const email = clean(data.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.');
  const opening = round2(num(data.openingBalance));
  const id = data.id || uuid();
  const now = nowISO();
  const rec = await idb.write([kind, 'entries', 'auditLog'], async (t) => {
    const old = data.id ? await t.get(kind, id) : null;
    const r = { ...(old || { createdAt: now }), id, name, nameLc: lc(name), phone: clean(data.phone, 40), email, address: clean(data.address, 300),
      note: clean(data.note, 500), openingBalance: opening, openingDate: data.openingDate || old?.openingDate || today(), active: data.active === false ? 0 : 1, updatedAt: now };
    await t.put(kind, r);
    const acc = partyAccount(kind, id);
    // Customers: opening = receivable (debit). Suppliers: opening = payable (credit).
    await setOpening(t, 'open:' + acc, acc, kind === 'customers' ? opening : -opening, r.openingDate, 'Opening balance');
    await audit(t, (old ? 'update_' : 'create_') + kind.slice(0, -1), { name });
    return r;
  });
  await Catalog.refreshParty(kind, id);
  document.dispatchEvent(new CustomEvent('data:changed'));
  return rec;
}

export async function deleteParty(kind, id) {
  Auth.require('party.delete');
  const acc = partyAccount(kind, id);
  const res = await idb.write([kind, 'entries', 'sales', 'purchases', 'auditLog'], async (t) => {
    const p = await t.get(kind, id);
    if (!p) throw new AppError('Not found.');
    const used = (await t.getAllByIndex('entries', 'accountId', acc)).some((e) => e.refType !== 'opening')
      || (await t.countByIndex(kind === 'customers' ? 'sales' : 'purchases', kind === 'customers' ? 'customerId' : 'supplierId', id)) > 0;
    if (used) {
      p.active = 0; p.updatedAt = nowISO(); await t.put(kind, p);
      await audit(t, 'deactivate_' + kind.slice(0, -1), { name: p.name });
      return 'deactivated';
    }
    await t.deleteByIndex('entries', 'txnId', 'open:' + acc);
    await t.delete(kind, id);
    await audit(t, 'delete_' + kind.slice(0, -1), { name: p.name });
    return 'deleted';
  });
  await Catalog.refreshParty(kind, id);
  document.dispatchEvent(new CustomEvent('data:changed'));
  return res;
}

export async function saveAccount(data) {
  Auth.require('account.manage');
  const id = data.id || uuid();
  const now = nowISO();
  const rec = await idb.write(['accounts', 'entries', 'auditLog'], async (t) => {
    const old = data.id ? await t.get('accounts', id) : null;
    const type = old?.system ? old.type : data.type;
    if (!ACCOUNT_TYPES[type]) throw new AppError('Select an account type.');
    const name = old?.system ? old.name : clean(data.name, 80);
    if (!name) throw new AppError('Account name is required.');
    const opening = round2(num(data.openingBalance));
    const r = { ...(old || { createdAt: now, system: false }), id, name, type, note: clean(data.note, 300), openingBalance: opening,
      openingDate: data.openingDate || old?.openingDate || today(), active: old?.system ? 1 : (data.active === false ? 0 : 1), updatedAt: now };
    await t.put('accounts', r);
    if (!['income', 'expense'].includes(type) && id !== 'equity') {
      await setOpening(t, 'open:' + id, id, isDebitNormal(type) ? opening : -opening, r.openingDate, 'Opening balance');
    }
    await audit(t, old ? 'update_account' : 'create_account', { name });
    return r;
  });
  document.dispatchEvent(new CustomEvent('data:changed'));
  return rec;
}

export async function deleteAccount(id) {
  Auth.require('account.manage');
  return idb.write(['accounts', 'entries', 'auditLog'], async (t) => {
    const a = await t.get('accounts', id);
    if (!a) throw new AppError('Account not found.');
    if (a.system) throw new AppError('System accounts cannot be deleted.');
    const used = (await t.getAllByIndex('entries', 'accountId', id)).some((e) => e.refType !== 'opening');
    if (used) { a.active = 0; a.updatedAt = nowISO(); await t.put('accounts', a); await audit(t, 'deactivate_account', { name: a.name }); return 'deactivated'; }
    await t.deleteByIndex('entries', 'txnId', 'open:' + id);
    await t.delete('accounts', id);
    await audit(t, 'delete_account', { name: a.name });
    return 'deleted';
  });
}

export async function saveCategory(data) {
  Auth.require('product.edit');
  const name = clean(data.name, 80);
  if (!name) throw new AppError('Group name is required.');
  const id = data.id || uuid();
  await idb.write(['categories'], async (t) => {
    const dup = (await t.getAllByIndex('categories', 'nameLc', lc(name))).find((c) => c.id !== id);
    if (dup) throw new AppError('A group with this name already exists.');
    const old = data.id ? await t.get('categories', id) : null;
    await t.put('categories', { ...(old || { createdAt: nowISO() }), id, name, nameLc: lc(name), updatedAt: nowISO() });
  });
  await Catalog.refreshCategories();
  return id;
}
export async function deleteCategory(id) {
  Auth.require('product.edit');
  await idb.write(['categories', 'products'], async (t) => {
    if (await t.countByIndex('products', 'categoryId', id)) throw new AppError('This group is used by medicines. Reassign them first.');
    await t.delete('categories', id);
  });
  await Catalog.refreshCategories();
}

// Medicine card. Stock is NOT edited here: it only changes through purchases, sales, returns and adjustments (batch-wise).
export async function saveProduct(data) {
  Auth.require('product.edit');
  const name = clean(data.name, 150);
  if (!name) throw new AppError('Medicine name is required.');
  const id = data.id || uuid();
  const sku = clean(data.sku, 60); const barcode = clean(data.barcode, 60);
  const salePrice = round2(num(data.salePrice)); const purchasePrice = round2(num(data.purchasePrice));
  const wholesalePrice = round2(num(data.wholesalePrice)); const mrp = round2(num(data.mrp));
  const looseUnitPrice = round2(num(data.looseUnitPrice));
  if (salePrice < 0 || purchasePrice < 0 || wholesalePrice < 0 || mrp < 0 || looseUnitPrice < 0) throw new AppError('Prices cannot be negative.');
  const packSize = Math.max(1, Math.floor(num(data.packSize, 1)));
  const boxSize = Math.max(1, Math.floor(num(data.boxSize, 1)));
  const drugClass = ['otc', 'rx', 'controlled', 'general'].includes(data.drugClass) ? data.drugClass : 'otc';
  const storage = ['room', 'cool', 'fridge'].includes(data.storage) ? data.storage : 'room';
  const ctx = newCtx();
  const rec = await idb.write(['products', 'auditLog'], async (t) => {
    if (barcode) {
      const dup = (await t.getAllByIndex('products', 'barcode', barcode)).find((p) => p.id !== id);
      if (dup) throw new AppError(`Barcode already used by "${dup.name}".`);
    }
    if (sku) {
      const dup = (await t.getAllByIndex('products', 'sku', sku)).find((p) => p.id !== id);
      if (dup) throw new AppError(`Code already used by "${dup.name}".`);
    }
    const old = data.id ? await t.get('products', id) : null;
    if (data.id && !old) throw new AppError('Medicine not found.');
    if (old && Math.abs(old.stock || 0) > EPS && (packSizeOf(old) !== packSize)) throw new AppError('Pack size cannot be changed while this medicine has stock. Sell or adjust the stock to zero first.');
    const now = nowISO();
    const trackStock = data.trackStock !== false;
    const generic = clean(data.generic, 120);
    const p = { ...(old || { createdAt: now, stock: 0 }), id, name, nameLc: lc(name), urduName: clean(data.urduName, 150), generic, genericLc: normName(generic),
      strength: clean(data.strength, 40), form: clean(data.form, 30) || 'Other', company: clean(data.company, 80),
      sku, barcode, categoryId: data.categoryId || '', packLabel: clean(data.packLabel, 20) || 'Strip', unitLabel: clean(data.unitLabel, 20) || 'Tablet',
      packSize, boxSize, looseSale: !!data.looseSale && packSize > 1, looseUnitPrice,
      mrp, purchasePrice, salePrice, wholesalePrice, minStock: round3(num(data.minStock)), trackStock, drugClass, storage,
      rack: clean(data.rack, 30), directions: clean(data.directions, 120),
      image: data.image === undefined ? (old?.image || '') : data.image, active: data.active === false ? 0 : 1, updatedAt: now };
    await t.put('products', p);
    ctx.touched.add(id);
    await audit(t, old ? 'update_product' : 'create_product', { name });
    return p;
  });
  await finish(ctx);
  return rec;
}

// Add many medicines at once (starter catalog). Existing name+strength pairs are skipped; no prices, no stock.
export async function bulkAddProducts(rows) {
  Auth.require('product.edit');
  const ctx = newCtx();
  const out = { added: 0, skipped: 0 };
  await idb.write(['products', 'auditLog'], async (t) => {
    const have = new Set((await t.getAll('products')).map((p) => lc(`${p.name}|${p.strength || ''}`)));
    const now = nowISO();
    for (const [name, strength, form, generic, company, drugClass, packSize, storage] of rows) {
      const key = lc(`${name}|${strength || ''}`);
      if (have.has(key)) { out.skipped++; continue; }
      have.add(key);
      const f = FORMS[form] || FORMS.Other;
      const ps = Math.max(1, Math.floor(packSize || f[2] || 1));
      const p = { id: uuid(), createdAt: now, updatedAt: now, stock: 0, name, nameLc: lc(name), urduName: '', generic: generic || '', genericLc: normName(generic), strength: strength || '', form,
        company: company || '', sku: '', barcode: '', categoryId: '', packLabel: f[0], unitLabel: f[1], packSize: ps, boxSize: 1, looseSale: !!f[3] && ps > 1, looseUnitPrice: 0,
        mrp: 0, purchasePrice: 0, salePrice: 0, wholesalePrice: 0, minStock: 0, trackStock: true, drugClass: drugClass || 'otc', storage: storage || 'room', rack: '', directions: '', image: '', active: 1 };
      await t.add('products', p);
      ctx.touched.add(p.id); out.added++;
    }
    await audit(t, 'starter_catalog', out);
  });
  await Catalog.load();
  document.dispatchEvent(new CustomEvent('data:changed'));
  return out;
}

export async function deleteProduct(id) {
  Auth.require('product.delete');
  const ctx = newCtx();
  const res = await idb.write(['products', 'batches', 'stockMoves', 'saleItems', 'purchaseItems', 'auditLog'], async (t) => {
    const p = await t.get('products', id);
    if (!p) throw new AppError('Medicine not found.');
    const used = (await t.countByIndex('stockMoves', 'productId', id)) || await t.countByIndex('saleItems', 'productId', id) || await t.countByIndex('purchaseItems', 'productId', id);
    ctx.touched.add(id);
    if (used) { p.active = 0; p.updatedAt = nowISO(); await t.put('products', p); await audit(t, 'deactivate_product', { name: p.name }); return 'deactivated'; }
    await t.delete('products', id);
    await audit(t, 'delete_product', { name: p.name });
    return 'deleted';
  });
  await finish(ctx);
  return res;
}

// ---------- STOCK ADJUSTMENTS (batch-wise) ----------
// lines: [{ productId, batchId, qty }]  or  [{ productId, newBatch:{batchNo, expiry, mrp, costPack}, qty }]   (qty in base units, + / −)
export async function saveAdjustment(input) {
  Auth.require('stock.adjust');
  const lines = (input.lines || []).map((l) => ({ ...l, qty: round3(num(l.qty)) })).filter((l) => l.qty !== 0);
  if (!lines.length) throw new AppError('Add at least one medicine with a non-zero quantity change.');
  const ctx = newCtx();
  const doc = await idb.write(['adjustments', ...STOCK_STORES], async (t) => {
    const existing = await t.get('adjustments', input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const number = await nextNumber(t, 'adjustment');
    const d = { id: input.id, number, date: input.date || today(), createdAt: nowISO(), reason: clean(input.reason, 60) || 'Adjustment', note: clean(input.note, 500), items: [], status: 'completed', ...stamp() };
    for (const l of lines) {
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('Medicine not found.');
      if (p.trackStock === false) throw new AppError(`"${p.name}" does not track stock.`);
      let batch;
      let before = 0;
      if (l.newBatch) {
        if (!(l.qty > 0)) throw new AppError('A new batch must have a positive quantity.');
        const bi = checkBatchInput(p, l.newBatch.batchNo, l.newBatch.expiry, d.date);
        const cost = l.newBatch.costPack !== undefined && l.newBatch.costPack !== '' ? num(l.newBatch.costPack) / packSizeOf(p) : (p.purchasePrice || 0) / packSizeOf(p);
        batch = await createBatch(t, p, { ...bi, qtyIn: l.qty, cost, mrp: num(l.newBatch.mrp) || p.mrp, srcType: 'adjustment', srcId: d.id, srcNo: number, date: d.date });
      } else {
        batch = await t.get('batches', l.batchId);
        if (!batch || batch.productId !== p.id) throw new AppError('Batch not found.');
        before = batch.qty;
      }
      d.items.push({ productId: p.id, name: p.name, strength: p.strength || '', batchId: batch.id, batchNo: batch.batchNo, expiry: batch.expiry, qty: l.qty, before, cost: batch.cost });
      await moveStock(t, ctx, { productId: p.id, batchId: batch.id, qty: l.qty, type: 'adjust', doc: d, cost: batch.cost, note: d.reason });
    }
    await t.add('adjustments', d);
    await audit(t, 'stock_adjustment', { number, lines: lines.length, reason: d.reason });
    return d;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}

// Remove everything left in a batch (expired / damaged / broken) as one adjustment.
export async function writeOffBatch(batchId, reason = 'Expired') {
  const b = await idb.get('batches', batchId);
  if (!b || !(b.qty > EPS)) throw new AppError('This batch has no stock left.');
  return saveAdjustment({ id: uuid(), reason, date: today(), lines: [{ productId: b.productId, batchId, qty: -b.qty }] });
}

// ---------- HELD SALES ----------
export const saveHold = (hold) => idb.write(['holds'], (t) => t.put('holds', { ...hold, createdAt: hold.createdAt || nowISO() }));
export const deleteHold = (id) => idb.write(['holds'], (t) => t.delete('holds', id));

// ---------- DEMAND / ORDER LIST ----------
export async function saveDemand(d) {
  Auth.require('demand.manage');
  const rec = await idb.write(['demands', 'auditLog'], async (t) => {
    const old = d.id ? await t.get('demands', d.id) : null;
    const name = clean(d.name, 150);
    if (!name) throw new AppError('Enter the medicine name.');
    const r = { ...(old || { createdAt: nowISO(), status: 'open', source: 'manual' }), ...d, id: d.id || uuid(), name, qty: Math.max(1, Math.floor(num(d.qty, 1))), note: clean(d.note, 200), updatedAt: nowISO() };
    await t.put('demands', r);
    return r;
  });
  document.dispatchEvent(new CustomEvent('demand:changed'));
  return rec;
}
export async function deleteDemand(id) {
  await idb.write(['demands'], (t) => t.delete('demands', id));
  document.dispatchEvent(new CustomEvent('demand:changed'));
}

// ---------- BALANCES & LEDGERS (always derived from entries) ----------
export async function allBalances() {
  const map = new Map();
  await idb.each('entries', null, null, (e) => {
    const b = map.get(e.accountId) || { debit: 0, credit: 0 };
    b.debit += e.debit; b.credit += e.credit; map.set(e.accountId, b);
  });
  for (const b of map.values()) { b.debit = round2(b.debit); b.credit = round2(b.credit); b.balance = round2(b.debit - b.credit); }
  return map;
}

export async function accountBalance(accountId, uptoDate = '9999-12-31') {
  const rows = await idb.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, ''], [accountId, uptoDate]));
  return round2(rows.reduce((s, e) => s + e.debit - e.credit, 0));
}

// Ledger rows with running balance (debit - credit).
export async function ledger(accountId, from, to) {
  const [before, rows] = await idb.read(['entries'], (t) => Promise.all([
    t.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, ''], [accountId, from], false, true)),
    t.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, from], [accountId, to])),
  ]));
  const opening = round2(before.reduce((s, e) => s + e.debit - e.credit, 0));
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let run = opening;
  for (const r of rows) { run = round2(run + r.debit - r.credit); r.running = run; }
  return { opening, rows, closing: run, debit: round2(rows.reduce((s, r) => s + r.debit, 0)), credit: round2(rows.reduce((s, r) => s + r.credit, 0)) };
}

// ---------- MAINTENANCE ----------
export async function rebuildStock() {
  Auth.require('settings.manage');
  const fixed = [];
  const ctx = newCtx();
  await idb.write(['products', 'batches', 'stockMoves'], async (t) => {
    const moves = await t.getAll('stockMoves');
    const perBatch = {};
    for (const m of moves) if (m.batchId) perBatch[m.batchId] = round3((perBatch[m.batchId] || 0) + m.qty);
    const perProduct = {};
    for (const b of await t.getAll('batches')) {
      const q = perBatch[b.id] || 0;
      if (Math.abs(b.qty - q) > EPS) { b.qty = q; await t.put('batches', b); }
      perProduct[b.productId] = round3((perProduct[b.productId] || 0) + b.qty);
    }
    for (const p of await t.getAll('products')) {
      if (p.trackStock === false) continue;
      const s = perProduct[p.id] || 0;
      if (!p.everStocked && moves.some((m) => m.productId === p.id && m.qty > 0)) { p.everStocked = true; await t.put('products', p); }
      if (Math.abs((p.stock || 0) - s) > EPS) { fixed.push({ name: p.name, was: p.stock, now: s }); p.stock = s; await t.put('products', p); ctx.touched.add(p.id); }
    }
  });
  await Catalog.load();
  await finish(ctx);
  return fixed;
}

export async function integrityCheck() {
  const issues = [];
  const [entries, products, moves, batches] = await idb.read(['entries', 'products', 'stockMoves', 'batches'], (t) => Promise.all([t.getAll('entries'), t.getAll('products'), t.getAll('stockMoves'), t.getAll('batches')]));
  const byTxn = {};
  for (const e of entries) { const b = byTxn[e.txnId] || (byTxn[e.txnId] = { d: 0, c: 0, ref: e.refNo }); b.d += e.debit; b.c += e.credit; }
  for (const [txn, b] of Object.entries(byTxn)) if (Math.abs(b.d - b.c) > 0.009) issues.push(`Unbalanced ledger for ${b.ref || txn}: Dr ${round2(b.d)} / Cr ${round2(b.c)}`);
  const perBatch = {};
  for (const m of moves) if (m.batchId) perBatch[m.batchId] = round3((perBatch[m.batchId] || 0) + m.qty);
  const perProduct = {};
  const name = Object.fromEntries(products.map((p) => [p.id, p.name]));
  for (const b of batches) {
    if (b.qty < -EPS) issues.push(`Negative stock in batch ${b.batchNo} of "${name[b.productId] || b.productId}": ${b.qty}`);
    if (Math.abs(b.qty - (perBatch[b.id] || 0)) > EPS) issues.push(`Batch ${b.batchNo} of "${name[b.productId] || b.productId}": stored ${b.qty}, stock ledger ${perBatch[b.id] || 0}`);
    perProduct[b.productId] = round3((perProduct[b.productId] || 0) + b.qty);
  }
  for (const p of products) if (p.trackStock !== false && Math.abs((p.stock || 0) - (perProduct[p.id] || 0)) > EPS) issues.push(`Stock mismatch for "${p.name}": card ${p.stock}, batches ${perProduct[p.id] || 0}`);
  return { issues, checked: { entries: entries.length, products: products.length, stockMoves: moves.length, batches: batches.length } };
}

