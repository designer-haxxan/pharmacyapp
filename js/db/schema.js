// IndexedDB schema definition and migrations.
import { CONFIG } from '../config.js';

export const DB_NAME = `${CONFIG.APP_ID}_pos`;
export const DB_VERSION = 1;

// Stores that make up the business data (included in backups).
export const DATA_STORES = [
  'categories', 'products', 'batches', 'customers', 'suppliers', 'accounts',
  'sales', 'saleItems', 'purchases', 'purchaseItems', 'saleReturns', 'purchaseReturns',
  'vouchers', 'entries', 'stockMoves', 'adjustments', 'demands', 'holds', 'auditLog', 'meta',
];

const STORES = {
  meta: { keyPath: 'key', indexes: {} },
  categories: { indexes: { nameLc: 'nameLc' } },
  products: { indexes: { nameLc: 'nameLc', barcode: 'barcode', sku: 'sku', categoryId: 'categoryId', generic: 'genericLc' } },
  // One row per received lot of a medicine (purchase line, opening stock or stock-in adjustment).
  batches: { indexes: { productId: 'productId', expiry: 'expiry', batchNo: 'batchNo', srcId: 'srcId', prodExp: [['productId', 'expiry'], false] } },
  customers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  suppliers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  accounts: { indexes: { type: 'type' } },
  sales: { indexes: { number: ['number', true], date: 'date', customerId: 'customerId' } },
  saleItems: { indexes: { saleId: 'saleId', productId: 'productId', date: 'date', batchId: 'batchId', batchNo: 'batchNo' } },
  purchases: { indexes: { number: ['number', true], date: 'date', supplierId: 'supplierId' } },
  purchaseItems: { indexes: { purchaseId: 'purchaseId', productId: 'productId', date: 'date', batchId: 'batchId' } },
  saleReturns: { indexes: { number: ['number', true], date: 'date', saleId: 'saleId', customerId: 'customerId' } },
  purchaseReturns: { indexes: { number: ['number', true], date: 'date', purchaseId: 'purchaseId', supplierId: 'supplierId' } },
  vouchers: { indexes: { number: ['number', true], date: 'date', type: 'type' } },
  entries: { indexes: { accountId: 'accountId', txnId: 'txnId', date: 'date', acctDate: [['accountId', 'date'], false] } },
  stockMoves: { indexes: { productId: 'productId', refId: 'refId', batchId: 'batchId', date: 'date', prodDate: [['productId', 'date'], false] } },
  adjustments: { indexes: { number: ['number', true], date: 'date' } },
  demands: { indexes: { status: 'status', productId: 'productId', createdAt: 'createdAt' } },
  holds: { indexes: { createdAt: 'createdAt' } },
  auditLog: { indexes: { at: 'at' } },
};

export const SYSTEM_ACCOUNTS = [
  { id: 'cash', name: 'Cash in Hand', type: 'cash' },
  { id: 'sales', name: 'Sales', type: 'income' },
  { id: 'sales_returns', name: 'Sales Returns', type: 'income' },
  { id: 'purchases', name: 'Purchases', type: 'expense' },
  { id: 'purchase_returns', name: 'Purchase Returns', type: 'expense' },
  { id: 'tax', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'equity', name: 'Opening Balance Equity', type: 'equity' },
  { id: 'income', name: 'Other Income', type: 'income' },
  { id: 'expense', name: 'General Expenses', type: 'expense' },
];

export function upgrade(db, oldVersion, t) {
  if (oldVersion < 1) {
    for (const [name, def] of Object.entries(STORES)) {
      const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
      for (const [idx, spec] of Object.entries(def.indexes)) {
        const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
        os.createIndex(idx, keyPath, { unique: !!unique });
      }
    }
    const now = new Date().toISOString();
    const acc = t.objectStore('accounts');
    for (const a of SYSTEM_ACCOUNTS) acc.put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now });
    t.objectStore('meta').put({ key: 'schemaVersion', value: 1 });
    t.objectStore('meta').put({ key: 'createdAt', value: now });
  }
  // Future migrations: if (oldVersion < 2) { ... }
}
