// English / Urdu translation. Keys are the English strings used in the UI; a missing key falls back to English.
// Urdu mode also flips the page to right-to-left (Bootstrap RTL stylesheet is swapped in).
//
// Two layers:
//  1. t('English text') in code returns the Urdu string while building markup.
//  2. An observer translates any remaining text/placeholder/title that EXACTLY matches a dictionary key
//     (dialogs, toasts, scanner messages, data such as "Walk-in Customer"), so no screen stays half-English.
import { storageKey } from '../config.js';
import { UR } from './ur.js';

const KEY = storageKey('lang');
let lang = 'en';
try { lang = localStorage.getItem(KEY) === 'ur' ? 'ur' : 'en'; } catch { /* storage unavailable */ }

export const getLang = () => lang;
export const isUrdu = () => lang === 'ur';

export function t(s) {
  if (lang !== 'ur' || s === undefined || s === null) return s;
  const k = String(s);
  return UR[k] ?? k;
}
// Both languages at once (used on big buttons so both readers understand): "Sell · بیچیں"
export const tb = (s) => (UR[s] ? `${s}<span class="ur-sub">${UR[s]}</span>` : s);

export function applyLang() {
  const ur = lang === 'ur';
  const html = document.documentElement;
  html.setAttribute('lang', ur ? 'ur' : 'en');
  html.setAttribute('dir', ur ? 'rtl' : 'ltr');
  const ltr = document.getElementById('bs-ltr'); const rtl = document.getElementById('bs-rtl');
  if (ltr) ltr.disabled = ur;
  if (rtl) rtl.disabled = !ur;
}

// ---------- automatic translation of whatever is on screen (Urdu mode only) ----------
const ATTRS = ['placeholder', 'title', 'aria-label'];
const SKIP = 'script,style,textarea,code,#print-area,.receipt,[data-no-i18n],[contenteditable]';
const seenMissing = (window.__i18nMissing = window.__i18nMissing || new Set());

function translateText(node) {
  const raw = node.nodeValue;
  if (!raw || !/[A-Za-z]/.test(raw)) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const ur = UR[trimmed];
  if (ur !== undefined) { if (ur !== trimmed) node.nodeValue = raw.replace(trimmed, ur); } // never rewrite identical text: it would re-trigger the observer forever
  else if (trimmed.length > 1 && trimmed.length < 90 && !/^[\d\W]+$/.test(trimmed)) seenMissing.add(trimmed);
}
function translateAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (!v) continue;
    const ur = UR[v.trim()];
    if (ur !== undefined) { if (ur !== v) el.setAttribute(a, ur); }
    else if (/[A-Za-z]/.test(v) && v.length < 90) seenMissing.add('@' + v.trim());
  }
}
function translateTree(root) {
  if (root.nodeType === 3) { if (!root.parentElement?.closest(SKIP)) translateText(root); return; }
  if (root.nodeType !== 1 || root.closest?.(SKIP)) return;
  translateAttrs(root);
  root.querySelectorAll?.('[placeholder],[title],[aria-label]').forEach((e) => { if (!e.closest(SKIP)) translateAttrs(e); });
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let n; while ((n = w.nextNode())) translateText(n);
}

let observer = null;
export function startAutoTranslate() {
  stopAutoTranslate();
  if (lang !== 'ur') return;
  translateTree(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => translateTree(n));
      else if (m.type === 'characterData') translateTree(m.target);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
export function stopAutoTranslate() { observer?.disconnect(); observer = null; }

// Translates static markup that carries data-i18n (text), data-i18n-ph (placeholder) or data-i18n-title.
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    if (!el.dataset.en) el.dataset.en = el.textContent;
    el.textContent = t(el.dataset.en);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    if (!el.dataset.enPh) el.dataset.enPh = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', t(el.dataset.enPh));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    if (!el.dataset.enTitle) el.dataset.enTitle = el.getAttribute('title') || '';
    el.setAttribute('title', t(el.dataset.enTitle));
  });
}

export function setLang(l) {
  lang = l === 'ur' ? 'ur' : 'en';
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  applyLang();
  document.dispatchEvent(new CustomEvent('lang:changed', { detail: lang }));
}
