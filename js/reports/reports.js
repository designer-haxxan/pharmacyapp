// Reports. Every figure is computed from transaction records (documents, entries, stock moves).
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, fmtTime, today, monthStart, localDate, round2, round3, toCSV, downloadFile } from '../core/utils.js';
import { money, balText, ledgerTable, REF_LABELS, rangeFor } from '../core/views.js';
import { getSettings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { stockText, packSizeOf, daysLeft, fmtExpiry, medTitle, isLowStock, packLabel } from '../core/pharma.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import { printHTML } from '../printer/printer.js';

const $ = window.jQuery;
const live = (x) => x.filter((d) => d.status !== 'void');
const byDate = (store, from, to) => idb.getAllByIndex(store, 'date', IDBKeyRange.bound(from, to));
const sum = (arr, f) => round2(arr.reduce((s, x) => s + ((typeof f === 'function' ? f(x) : x[f]) || 0), 0));

// Column helpers: [label, type] where type ∈ text|money|qty|date
const C = (label, type = 'text') => ({ label, type });

async function cashAccounts() { return (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type)); }

function docRows(docs, partyKey, route) {
  return docs.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)).map((d) => [
    { v: d.number, href: `#/${route}/${d.id}` }, d.date, d[partyKey], d.discount || 0, d.tax || 0, d.total, d.paid, d.balance]);
}
const docCols = (party) => [C('No'), C('Date', 'date'), C(party), C('Discount', 'money'), C('Tax', 'money'), C('Total', 'money'), C('Paid', 'money'), C('Balance', 'money')];
const docFoot = (docs) => ['Total', '', `${docs.length} docs`, sum(docs, 'discount'), sum(docs, 'tax'), sum(docs, 'total'), sum(docs, 'paid'), sum(docs, 'balance')];

async function ledgerReport(accountId, from, to, debitNormal, title) {
  const led = await Posting.ledger(accountId, from, to);
  return {
    summary: [['Opening', balText(led.opening, debitNormal)], ['Debits', money(led.debit)], ['Credits', money(led.credit)], ['Closing', balText(led.closing, debitNormal)]],
    html: ledgerTable(led, { debitNormal }),
    csv: [['Date', 'Ref', 'Type', 'Details', 'Debit', 'Credit', 'Balance'], ['', '', '', 'Opening', '', '', led.opening],
      ...led.rows.map((e) => [e.date, e.refNo, REF_LABELS[e.refType] || e.refType, e.memo, e.debit, e.credit, e.running]), ['', '', '', 'Closing', led.debit, led.credit, led.closing]],
    title,
  };
}

async function partyBalances(kind, asOf) {
  const prefix = kind === 'customers' ? 'C:' : 'S:';
  const map = new Map();
  await idb.each('entries', null, null, (e) => { if (e.accountId.startsWith(prefix) && e.date <= asOf) map.set(e.accountId, (map.get(e.accountId) || 0) + e.debit - e.credit); });
  const rows = [];
  for (const [acc, b] of map) {
    const bal = round2(kind === 'customers' ? b : -b);
    if (Math.abs(bal) < 0.005) continue;
    const p = Catalog.party(kind, acc.slice(2));
    rows.push([{ v: p?.name || acc, href: `#/${kind}/${acc.slice(2)}` }, p?.phone || '', bal]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  return rows;
}

export const REPORTS = {
  'daily-sales': {
    title: 'Daily sales', icon: 'calendar-day', group: 'Sales', filters: ['date'],
    async run({ date }) {
      const [sales, rets] = await Promise.all([byDate('sales', date, date), byDate('saleReturns', date, date)]);
      const s = live(sales); const r = live(rets);
      return {
        summary: [['Invoices', s.length], ['Gross sales', money(sum(s, 'total'))], ['Discounts', money(sum(s, 'discount'))], ['Tax', money(sum(s, 'tax'))],
          ['Collected', money(sum(s, 'paid'))], ['On credit', money(sum(s, 'balance'))], ['Returns', money(sum(r, 'total'))], ['Net sales', money(sum(s, 'total') - sum(r, 'total'))]],
        cols: [C('No'), C('Time'), C('Customer'), C('Pay via'), C('Total', 'money'), C('Paid', 'money'), C('Balance', 'money')],
        rows: s.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((d) => [{ v: d.number, href: `#/sales/${d.id}` }, fmtTime(d.createdAt), d.customerName, d.paymentAccountName, d.total, d.paid, d.balance]),
        foot: ['Total', '', '', '', sum(s, 'total'), sum(s, 'paid'), sum(s, 'balance')],
      };
    },
  },
  sales: {
    title: 'Sales by date range', icon: 'receipt', group: 'Sales', filters: ['range', 'customer'],
    async run({ from, to, customer }) {
      const docs = live(await byDate('sales', from, to)).filter((d) => !customer || d.customerId === customer);
      return { summary: [['Invoices', docs.length], ['Total', money(sum(docs, 'total'))], ['Paid', money(sum(docs, 'paid'))], ['Due', money(sum(docs, 'balance'))]],
        cols: docCols('Customer'), rows: docRows(docs, 'customerName', 'sales'), foot: docFoot(docs) };
    },
  },
  'sale-returns': {
    title: 'Sales returns', icon: 'arrow-return-left', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('saleReturns', from, to)).sort((a, b) => a.date.localeCompare(b.date));
      return { summary: [['Returns', docs.length], ['Total', money(sum(docs, 'total'))], ['Refunded', money(sum(docs, 'refund'))]],
        cols: [C('No'), C('Date', 'date'), C('Invoice'), C('Customer'), C('Items'), C('Total', 'money'), C('Refund', 'money')],
        rows: docs.map((d) => [{ v: d.number, href: `#/returns/sale/${d.id}` }, d.date, d.docNo, d.partyName, d.items.map((i) => `${i.name} ×${fmtQty(i.qty)}`).join(', '), d.total, d.refund]),
        foot: ['Total', '', '', '', '', sum(docs, 'total'), sum(docs, 'refund')] };
    },
  },
  'product-sales': {
    title: 'Medicine-wise sales', icon: 'capsule', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const [items, rets] = await Promise.all([byDate('saleItems', from, to), byDate('saleReturns', from, to)]);
      const map = new Map();
      const g = (id, name) => map.get(id) || (map.set(id, { name, qty: 0, amount: 0, cost: 0, rqty: 0, ramount: 0, rcost: 0 }), map.get(id));
      for (const i of items) { const x = g(i.productId, i.name); x.qty += i.baseQty; x.amount += i.amount; x.cost += i.baseQty * i.cost; }
      for (const r of live(rets)) for (const i of r.items) { const x = g(i.productId, i.name); x.rqty += i.baseQty; x.ramount += i.lineAmount ?? i.amount; x.rcost += i.baseQty * i.cost; }
      const rows = [...map.entries()].map(([id, x]) => {
        const net = round2(x.amount - x.ramount); const cost = round2(x.cost - x.rcost); const p = Catalog.product(id);
        return [{ v: x.name, href: `#/stock/${id}` }, stockText(p, round3(x.qty - x.rqty)), net, cost, round2(net - cost)];
      }).sort((a, b) => b[2] - a[2]);
      const canProfit = Auth.can('reports.profit');
      const cols = [C('Medicine'), C('Net qty sold', 'stock'), C('Net amount', 'money')];
      if (canProfit) cols.push(C('Cost', 'money'), C('Profit', 'money'));
      return { summary: [['Medicines', rows.length], ['Net amount', money(sum(rows, (r) => r[2]))], ...(canProfit ? [['Gross profit', money(sum(rows, (r) => r[4]))]] : [])],
        note: 'Amounts are line amounts before bill-level discount and tax.',
        cols, rows: canProfit ? rows : rows.map((r) => r.slice(0, 3)) };
    },
  },
  'company-sales': {
    title: 'Company-wise sales', icon: 'building', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const items = await byDate('saleItems', from, to);
      const map = new Map();
      for (const i of items) { const co = Catalog.product(i.productId)?.company || '—'; const x = map.get(co) || { amount: 0, cost: 0, n: new Set() }; x.amount += i.amount; x.cost += i.baseQty * i.cost; x.n.add(i.productId); map.set(co, x); }
      const canProfit = Auth.can('reports.profit');
      const rows = [...map.entries()].map(([co, x]) => [co, x.n.size, round2(x.amount), ...(canProfit ? [round2(x.amount - x.cost)] : [])]).sort((a, b) => b[2] - a[2]);
      return { summary: [['Companies', rows.length], ['Sales', money(sum(rows, (r) => r[2]))]], cols: [C('Company'), C('Medicines sold', 'qty'), C('Sales', 'money'), ...(canProfit ? [C('Profit', 'money')] : [])], rows };
    },
  },
  'salt-sales': {
    title: 'Salt / generic-wise sales', icon: 'droplet-half', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const items = await byDate('saleItems', from, to);
      const map = new Map();
      for (const i of items) { const g = Catalog.product(i.productId)?.generic || '—'; const x = map.get(g) || { amount: 0, brands: new Set() }; x.amount += i.amount; x.brands.add(i.name); map.set(g, x); }
      const rows = [...map.entries()].map(([g, x]) => [g, x.brands.size, round2(x.amount)]).sort((a, b) => b[2] - a[2]);
      return { summary: [['Salts', rows.length], ['Sales', money(sum(rows, (r) => r[2]))]], cols: [C('Generic / salt'), C('Brands sold', 'qty'), C('Sales', 'money')], rows };
    },
  },
  purchases: {
    title: 'Purchases', icon: 'bag', group: 'Purchases', perm: 'purchase.manage', filters: ['range', 'supplier'],
    async run({ from, to, supplier }) {
      const docs = live(await byDate('purchases', from, to)).filter((d) => !supplier || d.supplierId === supplier);
      return { summary: [['Purchases', docs.length], ['Total', money(sum(docs, 'total'))], ['Paid', money(sum(docs, 'paid'))], ['Due', money(sum(docs, 'balance'))]],
        cols: docCols('Supplier'), rows: docRows(docs, 'supplierName', 'purchases'), foot: docFoot(docs) };
    },
  },
  'purchase-returns': {
    title: 'Purchase returns', icon: 'arrow-return-right', group: 'Purchases', perm: 'purchase.manage', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('purchaseReturns', from, to)).sort((a, b) => a.date.localeCompare(b.date));
      return { summary: [['Returns', docs.length], ['Total', money(sum(docs, 'total'))], ['Refund received', money(sum(docs, 'refund'))]],
        cols: [C('No'), C('Date', 'date'), C('Purchase'), C('Supplier'), C('Items'), C('Total', 'money'), C('Refund', 'money')],
        rows: docs.map((d) => [{ v: d.number, href: `#/returns/purchase/${d.id}` }, d.date, d.docNo, d.partyName, d.items.map((i) => `${i.name} ×${fmtQty(i.qty)}`).join(', '), d.total, d.refund]),
        foot: ['Total', '', '', '', '', sum(docs, 'total'), sum(docs, 'refund')] };
    },
  },
  'product-purchases': {
    title: 'Medicine-wise purchases', icon: 'boxes', group: 'Purchases', perm: 'purchase.manage', filters: ['range'],
    async run({ from, to }) {
      const [items, rets] = await Promise.all([byDate('purchaseItems', from, to), byDate('purchaseReturns', from, to)]);
      const map = new Map();
      const g = (id, name) => map.get(id) || (map.set(id, { name, qty: 0, bonus: 0, amount: 0, rqty: 0, ramount: 0 }), map.get(id));
      for (const i of items) { const x = g(i.productId, i.name); x.qty += i.baseQty - (i.bonus || 0) * i.mult; x.bonus += (i.bonus || 0) * i.mult; x.amount += i.amount; }
      for (const r of live(rets)) for (const i of r.items) { const x = g(i.productId, i.name); x.rqty += i.baseQty; x.ramount += i.lineAmount ?? i.amount; }
      const rows = [...map.entries()].map(([id, x]) => { const p = Catalog.product(id); return [{ v: x.name, href: `#/stock/${id}` }, stockText(p, round3(x.qty)), stockText(p, round3(x.bonus)), stockText(p, round3(x.rqty)), round2(x.amount - x.ramount)]; }).sort((a, b) => b[4] - a[4]);
      return { summary: [['Medicines', rows.length], ['Net amount', money(sum(rows, (r) => r[4]))]],
        cols: [C('Medicine'), C('Purchased', 'stock'), C('Bonus (free)', 'stock'), C('Returned', 'stock'), C('Net amount', 'money')], rows };
    },
  },
  'supplier-purchases': {
    title: 'Supplier-wise purchases', icon: 'truck', group: 'Purchases', perm: 'purchase.manage', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('purchases', from, to));
      const map = new Map();
      for (const d of docs) { const x = map.get(d.supplierName) || { n: 0, total: 0, paid: 0 }; x.n++; x.total += d.total; x.paid += d.paid; map.set(d.supplierName, x); }
      const rows = [...map.entries()].map(([n, x]) => [n, x.n, round2(x.total), round2(x.paid), round2(x.total - x.paid)]).sort((a, b) => b[2] - a[2]);
      return { summary: [['Suppliers', rows.length], ['Total', money(sum(rows, (r) => r[2]))], ['Due', money(sum(rows, (r) => r[4]))]], cols: [C('Supplier'), C('Bills', 'qty'), C('Total', 'money'), C('Paid', 'money'), C('Due', 'money')], rows };
    },
  },
  'customer-ledger': {
    title: 'Customer ledger', icon: 'person-lines-fill', group: 'Parties', filters: ['range', 'customer*'],
    run: async ({ from, to, customer }) => ledgerReport('C:' + customer, from, to, true, Catalog.party('customers', customer)?.name),
  },
  'supplier-ledger': {
    title: 'Supplier ledger', icon: 'truck', group: 'Parties', perm: 'purchase.manage', filters: ['range', 'supplier*'],
    run: async ({ from, to, supplier }) => ledgerReport('S:' + supplier, from, to, false, Catalog.party('suppliers', supplier)?.name),
  },
  receivables: {
    title: 'Receivables', icon: 'person-down', group: 'Parties', filters: ['asof'],
    async run({ date }) {
      const rows = await partyBalances('customers', date);
      return { summary: [['Customers', rows.length], ['Total receivable', money(sum(rows, (r) => Math.max(0, r[2])))], ['Advances', money(-sum(rows, (r) => Math.min(0, r[2])))]],
        cols: [C('Customer'), C('Phone'), C('Balance', 'money')], rows, foot: ['Total', '', sum(rows, (r) => r[2])] };
    },
  },
  payables: {
    title: 'Payables', icon: 'cash-stack', group: 'Parties', perm: 'purchase.manage', filters: ['asof'],
    async run({ date }) {
      const rows = await partyBalances('suppliers', date);
      return { summary: [['Suppliers', rows.length], ['Total payable', money(sum(rows, (r) => Math.max(0, r[2])))], ['Advances paid', money(-sum(rows, (r) => Math.min(0, r[2])))]],
        cols: [C('Supplier'), C('Phone'), C('Balance', 'money')], rows, foot: ['Total', '', sum(rows, (r) => r[2])] };
    },
  },
  'cash-book': {
    title: 'Cash book', icon: 'journal-text', group: 'Accounts', filters: ['range', 'cashAccount'],
    run: async ({ from, to, account }) => ledgerReport(account || 'cash', from, to, true, (await idb.get('accounts', account || 'cash'))?.name),
  },
  'account-ledger': {
    title: 'Account ledger', icon: 'bank', group: 'Accounts', perm: 'account.manage', filters: ['range', 'account'],
    async run({ from, to, account }) {
      const a = await idb.get('accounts', account || 'cash');
      return ledgerReport(a.id, from, to, Posting.isDebitNormal(a.type), a.name);
    },
  },
  'daily-closing': {
    title: 'Daily closing', icon: 'door-closed', group: 'Accounts', filters: ['date'],
    async run({ date }) {
      const [sales, rets, vouchers, purchases] = await Promise.all([byDate('sales', date, date), byDate('saleReturns', date, date), byDate('vouchers', date, date), byDate('purchases', date, date)]);
      const s = live(sales); const v = live(vouchers);
      const rows = [];
      for (const a of await cashAccounts()) {
        const led = await Posting.ledger(a.id, date, date);
        if (!led.rows.length && Math.abs(led.opening) < 0.005) continue;
        rows.push([{ v: a.name, href: Auth.can('account.manage') ? `#/accounts/${a.id}` : null }, led.opening, led.debit, led.credit, led.closing]);
      }
      return {
        summary: [['Invoices', s.length], ['Sales', money(sum(s, 'total'))], ['Cash/bank sales', money(sum(s, 'paid'))], ['Credit sales', money(sum(s, 'balance'))],
          ['Sale returns', money(sum(live(rets), 'total'))], ['Purchases', money(sum(live(purchases), 'total'))],
          ['Receipts', money(sum(v.filter((x) => x.type === 'receipt'), 'amount'))], ['Payments', money(sum(v.filter((x) => x.type === 'payment'), 'amount'))]],
        cols: [C('Cash / bank account'), C('Opening', 'money'), C('In', 'money'), C('Out', 'money'), C('Closing', 'money')], rows,
        foot: ['Total', sum(rows, (r) => r[1]), sum(rows, (r) => r[2]), sum(rows, (r) => r[3]), sum(rows, (r) => r[4])],
      };
    },
  },
  stock: {
    title: 'Stock report', icon: 'clipboard-data', group: 'Inventory', filters: ['asof'],
    async run({ date }) {
      const qty = new Map();
      await idb.each('stockMoves', 'date', IDBKeyRange.upperBound(date), (m) => qty.set(m.productId, round3((qty.get(m.productId) || 0) + m.qty)));
      const rows = Catalog.allProducts().filter((p) => p.trackStock !== false && (p.active || qty.get(p.id))).sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => { const q = qty.get(p.id) || 0; const ps = packSizeOf(p); return [{ v: medTitle(p), href: `#/stock/${p.id}` }, p.company || '', stockText(p, q), round2(q * (p.purchasePrice || 0) / ps), round2(q * (p.salePrice || 0) / ps)]; });
      return { summary: [['Medicines', rows.length], ['Value at cost', money(sum(rows, (r) => r[3]))], ['Value at sale price', money(sum(rows, (r) => r[4]))]],
        note: 'Quantities are calculated from stock movements up to the selected date; values use current prices.',
        cols: [C('Medicine'), C('Company'), C('Stock', 'stock'), C('Value (cost)', 'money'), C('Value (sale)', 'money')], rows,
        foot: ['Total', '', '', sum(rows, (r) => r[3]), sum(rows, (r) => r[4])] };
    },
  },
  'batch-stock': {
    title: 'Batch-wise stock', icon: 'upc', group: 'Inventory', filters: [],
    async run() {
      const rows = Catalog.allBatches().map((b) => ({ b, p: Catalog.product(b.productId) })).filter((x) => x.p).sort((a, c) => a.p.name.localeCompare(c.p.name) || a.b.expiry.localeCompare(c.b.expiry))
        .map(({ b, p }) => [{ v: medTitle(p), href: `#/trace/${b.id}` }, b.batchNo, fmtExpiry(b.expiry), stockText(p, b.qty), round2(b.qty * (b.cost || 0)), round2(b.qty / packSizeOf(p) * (b.mrp || p.mrp || 0))]);
      return { summary: [['Batches', rows.length], ['Value at cost', money(sum(rows, (r) => r[4]))], ['Value at MRP', money(sum(rows, (r) => r[5]))]],
        cols: [C('Medicine'), C('Batch'), C('Expiry'), C('Stock', 'stock'), C('Cost value', 'money'), C('MRP value', 'money')], rows,
        foot: ['Total', '', '', '', sum(rows, (r) => r[4]), sum(rows, (r) => r[5])] };
    },
  },
  expiry: {
    title: 'Expiry report', icon: 'calendar2-x', group: 'Inventory', filters: ['expdays'],
    async run({ days }) {
      const lim = Number(days === undefined || days === '' ? 90 : days);
      const rows = Catalog.allBatches().map((b) => ({ b, p: Catalog.product(b.productId), d: daysLeft(b.expiry) })).filter((x) => x.p && x.d <= lim).sort((a, c) => a.d - c.d)
        .map(({ b, p, d }) => [{ v: medTitle(p), href: `#/trace/${b.id}` }, b.batchNo, fmtExpiry(b.expiry), d < 0 ? `Expired ${-d} days ago` : `${d} days`, stockText(p, b.qty), b.supplierName || '', round2(b.qty * (b.cost || 0))]);
      return { summary: [['Batches', rows.length], ['Value at cost', money(sum(rows, (r) => r[6]))]],
        cols: [C('Medicine'), C('Batch'), C('Expiry'), C('Time left'), C('Stock', 'stock'), C('Supplier'), C('Cost value', 'money')], rows, foot: ['Total', '', '', '', '', '', sum(rows, (r) => r[6])] };
    },
  },
  reorder: {
    title: 'Low stock / reorder', icon: 'exclamation-triangle', group: 'Inventory', filters: [],
    async run() {
      const rows = Catalog.allProducts().filter((p) => p.active && isLowStock(p)).sort((a, b) => a.stock - b.stock)
        .map((p) => [{ v: medTitle(p), href: `#/stock/${p.id}` }, p.company || '', stockText(p, p.stock), `${p.minStock || 0} ${packLabel(p)}`, p.lastSupplierName || '']);
      return { summary: [['Medicines to order', rows.length]], cols: [C('Medicine'), C('Company'), C('In stock', 'stock'), C('Minimum'), C('Last supplier')], rows };
    },
  },
  'dead-stock': {
    title: 'Dead stock (not selling)', icon: 'hourglass-split', group: 'Inventory', filters: ['range'],
    async run({ from, to }) {
      const items = await byDate('saleItems', from, to);
      const sold = new Set(items.map((i) => i.productId));
      const rows = Catalog.allProducts().filter((p) => p.active && p.trackStock !== false && p.stock > 0 && !sold.has(p.id)).map((p) => [{ v: medTitle(p), href: `#/stock/${p.id}` }, p.company || '', stockText(p, p.stock), round2(p.stock * (p.purchasePrice || 0) / packSizeOf(p))]).sort((a, b) => b[3] - a[3]);
      return { summary: [['Medicines', rows.length], ['Money stuck', money(sum(rows, (r) => r[3]))]], note: 'Medicines in stock that were not sold in the selected period.', cols: [C('Medicine'), C('Company'), C('Stock', 'stock'), C('Value (cost)', 'money')], rows, foot: ['Total', '', '', sum(rows, (r) => r[3])] };
    },
  },
  profit: {
    title: 'Profit summary', icon: 'graph-up-arrow', group: 'Accounts', perm: 'reports.profit', filters: ['range'],
    async run({ from, to }) {
      const [sales, items, rets, entries, accounts, moves] = await Promise.all([byDate('sales', from, to), byDate('saleItems', from, to), byDate('saleReturns', from, to), byDate('entries', from, to), idb.getAll('accounts'), byDate('stockMoves', from, to)]);
      const s = live(sales); const r = live(rets);
      const grossSales = sum(s, (d) => d.total - d.tax);
      const returns = sum(r, (d) => d.total - d.tax);
      const netSales = round2(grossSales - returns);
      const cogs = round2(sum(items, (i) => i.baseQty * i.cost) - sum(r, (d) => d.items.reduce((a, i) => a + i.baseQty * i.cost, 0)));
      const gross = round2(netSales - cogs);
      const types = Object.fromEntries(accounts.map((a) => [a.id, a.type]));
      const skip = new Set(['sales', 'sales_returns', 'purchases', 'purchase_returns']);
      const inc = entries.filter((e) => types[e.accountId] === 'income' && !skip.has(e.accountId));
      const exp = entries.filter((e) => types[e.accountId] === 'expense' && !skip.has(e.accountId));
      const otherIncome = sum(inc, (e) => e.credit - e.debit);
      const expenses = sum(exp, (e) => e.debit - e.credit);
      const writeOff = sum(moves.filter((m) => m.type === 'adjust'), (m) => -m.qty * m.cost);
      const net = round2(gross + otherIncome - expenses - writeOff);
      const rows = [['Sales (excl. tax, after discounts)', grossSales], ['Less: sales returns', -returns], ['Net sales', netSales], ['Less: cost of goods sold', -cogs], ['Gross profit', gross],
        ['Add: other income', otherIncome], ['Less: expenses', -expenses], ['Less: stock adjustments (loss) / gain', -writeOff], ['Net profit', net]];
      return { summary: [['Net sales', money(netSales)], ['Gross profit', money(gross)], ['Gross margin', netSales ? fmtNum((gross / netSales) * 100) + '%' : '—'], ['Net profit', money(net)]],
        note: 'Cost of goods sold uses the purchase price recorded on each sale line at the time of sale.',
        cols: [C('Item'), C('Amount', 'money')], rows, boldRows: [2, 4, 8] };
    },
  },
};

// ---------- rendering ----------
function cell(v, type) {
  if (v && typeof v === 'object') return v.href ? `<a href="${esc(v.href)}">${esc(v.v)}</a>` : esc(v.v);
  if (v === '' || v === null || v === undefined) return '';
  if (type === 'money') return fmtNum(v);
  if (type === 'qty') return fmtQty(v);
  if (type === 'stock') return esc(v);
  if (type === 'date') return fmtDate(v);
  return typeof v === 'number' && type !== 'text' ? fmtNum(v) : esc(v);
}
const raw = (v) => (v && typeof v === 'object' ? v.v : v);

function tableHTML(res) {
  const num = (c) => (c.type === 'money' || c.type === 'qty' || c.type === 'stock' ? 'num' : '');
  return `<div class="table-responsive"><table class="table table-sm table-hover table-report mb-0">
    <thead><tr>${res.cols.map((c) => `<th class="${num(c)}">${esc(t(c.label))}</th>`).join('')}</tr></thead>
    <tbody>${res.rows.length ? res.rows.map((r, i) => `<tr class="${res.boldRows?.includes(i) ? 'fw-bold table-light' : ''}">${r.map((v, j) => `<td class="${num(res.cols[j])}">${cell(v, res.cols[j].type)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${res.cols.length}" class="text-center text-body-secondary py-4">${t('No data for the selected filters')}</td></tr>`}</tbody>
    ${res.foot && res.rows.length ? `<tfoot><tr class="fw-semibold">${res.foot.map((v, j) => `<td class="${num(res.cols[j])}">${typeof v === 'number' ? cell(v, res.cols[j].type) : esc(v)}</td>`).join('')}</tr></tfoot>` : ''}
    </table></div>`;
}

function renderIndex(el) {
  const groups = {};
  for (const [key, r] of Object.entries(REPORTS)) {
    if (r.perm && !Auth.can(r.perm)) continue;
    (groups[r.group] ||= []).push([key, r]);
  }
  const order = ['Inventory', 'Sales', 'Purchases', 'Parties', 'Accounts'];
  const entries = Object.entries(groups).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  $(el).html(UI.pageHeader(t('Reports')) + entries.map(([g, list]) => `<h2 class="h6 text-body-secondary mt-3">${esc(t(g))}</h2>
    <div class="row g-2 stagger">${list.map(([k, r]) => `<div class="col-6 col-md-4 col-xl-3"><a class="quick-action h-100" href="#/reports/${k}"><i class="bi bi-${r.icon}"></i>${esc(t(r.title))}</a></div>`).join('')}</div>`).join(''));
}

async function renderReport(el, key) {
  const rep = REPORTS[key];
  const $el = $(el);
  if (!rep || (rep.perm && !Auth.can(rep.perm))) { $el.html(UI.pageHeader(t('Reports'), '', '#/reports') + UI.emptyState(t('Report not available'), 'shield-lock')); return; }
  const f = { from: monthStart(), to: today(), date: today(), customer: '', supplier: '', account: 'cash', days: '90' };
  if (key === 'dead-stock') { const d = new Date(); d.setDate(d.getDate() - 90); f.from = localDate(d); }
  const accs = rep.filters.includes('cashAccount') ? await cashAccounts() : rep.filters.includes('account') ? await idb.getAll('accounts') : [];
  const fl = rep.filters;
  const partySel = (kind, req) => `<div class="flex-grow-2"><label class="form-label small mb-0">${kind === 'customers' ? t('Customer') : t('Supplier')}${req ? ' *' : ''}</label>
    <select name="${kind === 'customers' ? 'customer' : 'supplier'}" class="form-select form-select-sm">${req ? `<option value="">${t('Select…')}</option>` : `<option value="">${t('All')}</option>`}${UI.options(Catalog.allParties(kind).sort((a, b) => a.name.localeCompare(b.name)), '')}</select></div>`;
  $el.html(UI.pageHeader(t(rep.title), `<button class="btn btn-light btn-sm btn-print"><i class="bi bi-printer"></i><span class="d-none d-sm-inline"> ${t('Print')}</span></button><button class="btn btn-light btn-sm btn-csv"><i class="bi bi-filetype-csv"></i><span class="d-none d-sm-inline"> CSV</span></button>`, '#/reports') + `
    <form class="filters rep-filters">
      ${fl.includes('range') ? `<div><label class="form-label small mb-0">${t('From')}</label><input type="date" name="from" class="form-control form-control-sm" value="${f.from}"></div><div><label class="form-label small mb-0">${t('To')}</label><input type="date" name="to" class="form-control form-control-sm" value="${f.to}"></div>` : ''}
      ${fl.includes('date') || fl.includes('asof') ? `<div><label class="form-label small mb-0">${fl.includes('asof') ? t('As of') : t('Date')}</label><input type="date" name="date" class="form-control form-control-sm" value="${f.date}"></div>` : ''}
      ${fl.includes('customer') || fl.includes('customer*') ? partySel('customers', fl.includes('customer*')) : ''}
      ${fl.includes('supplier') || fl.includes('supplier*') ? partySel('suppliers', fl.includes('supplier*')) : ''}
      ${fl.includes('expdays') ? `<div><label class="form-label small mb-0">${t('Show medicines expiring within')}</label><select name="days" class="form-select form-select-sm">${[['-1', 'Already expired'], ['30', '30 days'], ['60', '60 days'], ['90', '3 months'], ['180', '6 months'], ['365', '1 year']].map(([v, l]) => `<option value="${v}" ${v === '90' ? 'selected' : ''}>${t(l)}</option>`).join('')}</select></div>` : ''}
      ${fl.includes('cashAccount') || fl.includes('account') ? `<div><label class="form-label small mb-0">${t('Account')}</label><select name="account" class="form-select form-select-sm">${UI.options(accs, 'cash')}</select></div>` : ''}
      <div class="d-flex align-items-end gap-1" style="flex:0 0 auto">
        ${fl.includes('range') ? `<div class="btn-group btn-group-sm"><button type="button" class="btn btn-outline-secondary" data-range="today">${t('Today')}</button><button type="button" class="btn btn-outline-secondary" data-range="month">${t('Month')}</button><button type="button" class="btn btn-outline-secondary" data-range="all">${t('All')}</button></div>` : ''}
        <button class="btn btn-primary btn-sm">${t('Run')}</button></div>
    </form>
    <div class="rep-out"></div>`);
  let res = null;
  const run = async () => {
    Object.assign(f, Object.fromEntries(new FormData($el.find('.rep-filters')[0]).entries()));
    if ((fl.includes('customer*') && !f.customer) || (fl.includes('supplier*') && !f.supplier)) {
      $el.find('.rep-out').html(UI.emptyState(fl.includes('customer*') ? t('Select a customer to view the ledger') : t('Select a supplier to view the ledger'), 'person')); res = null; return;
    }
    $el.find('.rep-out').html(UI.spinner(t('Calculating…')));
    try {
      res = await rep.run(f);
      $el.find('.rep-out').html(`${res.summary ? `<div class="row g-2 mb-3">${res.summary.map(([l, v]) => `<div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">${esc(t(l))}</div><div class="fw-bold money">${v}</div></div></div></div>`).join('')}</div>` : ''}
        ${res.note ? `<div class="small text-body-secondary mb-2">${esc(t(res.note))}</div>` : ''}
        <div class="card"><div class="card-body p-0">${res.html || tableHTML(res)}</div></div>`);
    } catch (e) { $el.find('.rep-out').html(UI.errorState(e)); }
  };
  const period = () => (fl.includes('range') ? `${fmtDate(f.from)} – ${fmtDate(f.to)}` : fmtDate(f.date));
  $el.on('submit', '.rep-filters', (e) => { e.preventDefault(); run(); });
  $el.on('change', '.rep-filters select', run);
  $el.on('click', '[data-range]', function () { const [a, b] = rangeFor(this.dataset.range); $el.find('[name=from]').val(a); $el.find('[name=to]').val(b); run(); });
  $el.on('click', '.btn-print', () => {
    if (!res) return;
    const b = getSettings().business;
    printHTML(`<div class="print-report"><h2>${esc(b.name)}</h2><div><b>${esc(t(rep.title))}</b>${res.title ? ' — ' + esc(res.title) : ''}</div><div>${esc(period())} · ${t('printed')} ${new Date().toLocaleString()}</div><br>
      ${res.summary ? `<table style="margin-bottom:8px"><tr>${res.summary.map(([l, v]) => `<td><div>${esc(t(l))}</div><b>${v}</b></td>`).join('')}</tr></table>` : ''}
      ${res.html || tableHTML(res)}</div>`, { page: 'A4' });
  });
  $el.on('click', '.btn-csv', () => {
    if (!res) return;
    const rows = res.csv || [res.cols.map((c) => c.label), ...res.rows.map((r) => r.map(raw)), ...(res.foot ? [res.foot] : [])];
    downloadFile(`${key}-${fl.includes('range') ? f.from + '_' + f.to : f.date}.csv`, '﻿' + toCSV(rows), 'text/csv;charset=utf-8');
  });
  if (!(fl.includes('customer*') || fl.includes('supplier*'))) await run();
  else $el.find('.rep-out').html(UI.emptyState(fl.includes('customer*') ? t('Select a customer to view the ledger') : t('Select a supplier to view the ledger'), 'person'));
}

export default {
  async render(el, { params }) {
    if (params[0]) await renderReport(el, params[0]); else renderIndex(el);
  },
};
