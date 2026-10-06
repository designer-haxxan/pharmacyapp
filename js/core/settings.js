// Lightweight settings/preferences stored in LocalStorage (never operational data or secrets).
import { storageKey } from '../config.js';

const KEY = storageKey('settings');

export const DEFAULT_SETTINGS = {
  business: { name: 'My Pharmacy', nameUr: '', address: '', phone: '', taxNo: '', licenseNo: '', pharmacist: '', footer: 'Get well soon! Keep medicines away from children.' },
  currency: 'Rs',
  taxEnabled: false,
  taxRate: 0,
  allowNegativeStock: false,
  updatePurchasePrice: true,
  syncSalePrice: true,          // when a purchase brings a new MRP, the sale price follows it
  expiryAlertDays: 90,          // "near expiry" window used for warnings
  orderDays: 15,                // order enough stock for this many days of sales when suggesting quantities
  rxRequireDetails: false,      // ask patient/doctor for every Rx medicine (controlled drugs always ask)
  receiptShowBatch: false,
  receiptShowDirections: true,
  prefixes: { sale: 'SALE', purchase: 'PUR', saleReturn: 'SRN', purchaseReturn: 'PRN', receipt: 'RCV', payment: 'PAY', transfer: 'TRF', adjustment: 'ADJ' },
  printer: { method: 'browser', width: 58, autoPrint: false, copies: 1, chunkSize: 20, imageMode: 'gsv0', deviceName: '', deviceId: '' },
  theme: 'auto',
  register: 'Main',
};

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

let cache = null;
export function getSettings() {
  if (!cache) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { stored = {}; }
    cache = merge(DEFAULT_SETTINGS, stored);
  }
  return cache;
}

export function saveSettings(patch) {
  cache = merge(getSettings(), patch);
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
  return cache;
}

export function replaceSettings(all) {
  cache = merge(DEFAULT_SETTINGS, all || {});
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
}

// Small per-device preference helpers
export const pref = {
  get(k, d = null) { try { const v = localStorage.getItem(storageKey('pref.' + k)); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(storageKey('pref.' + k), JSON.stringify(v)); },
};

export function applyTheme() {
  const t = getSettings().theme;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1210' : '#effaf5');
}
