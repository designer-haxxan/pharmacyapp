// Settings: language, pharmacy profile, pharmacy rules, tax & numbering, printer, appearance, account, data tools.
import { CONFIG } from '../config.js';
import * as UI from '../core/ui.js';
import { esc, num, fmtDateTime } from '../core/utils.js';
import { getSettings, saveSettings } from '../core/settings.js';
import { t, getLang, setLang } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;

function section(title, icon, body) {
  return `<div class="card mb-3"><div class="card-body"><h2 class="h6 mb-3"><i class="bi bi-${icon} me-2"></i>${title}</h2>${body}</div></div>`;
}
const sw = (name, id, label, checked, ro) => `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="${name}" id="${id}" ${checked ? 'checked' : ''} ${ro}><label class="form-check-label" for="${id}">${label}</label></div></div>`;

export default {
  async render(el) {
    const $el = $(el).off();
    const s = getSettings();
    const u = Auth.user();
    const manage = Auth.can('settings.manage');
    const cap = Printer.capabilities();
    const ro = manage ? '' : 'disabled';
    const P = s.prefixes;
    $el.html(UI.pageHeader(t('Settings')) + `<div class="row g-3"><div class="col-lg-6">
      ${section(t('Language / زبان'), 'translate', `<div class="d-flex gap-2"><button class="btn btn-lg flex-fill ${getLang() === 'en' ? 'btn-primary' : 'btn-outline-primary'} btn-lang" data-l="en">English</button><button class="btn btn-lg flex-fill ${getLang() === 'ur' ? 'btn-primary' : 'btn-outline-primary'} btn-lang" data-l="ur">اردو</button></div>`)}
      ${section(t('Pharmacy profile'), 'hospital', `<form class="f-business row g-2">
        <div class="col-12 col-md-6"><label class="form-label">${t('Pharmacy name')}</label><input name="name" class="form-control" value="${esc(s.business.name)}" ${ro}></div>
        <div class="col-12 col-md-6"><label class="form-label">${t('Pharmacy name in Urdu')}</label><input name="nameUr" class="form-control" dir="rtl" value="${esc(s.business.nameUr)}" ${ro}></div>
        <div class="col-12"><label class="form-label">${t('Address')}</label><input name="address" class="form-control" value="${esc(s.business.address)}" ${ro}></div>
        <div class="col-6"><label class="form-label">${t('Phone')}</label><input name="phone" class="form-control" inputmode="tel" value="${esc(s.business.phone)}" ${ro}></div>
        <div class="col-6"><label class="form-label">${t('NTN')}</label><input name="taxNo" class="form-control" value="${esc(s.business.taxNo)}" ${ro}></div>
        <div class="col-6"><label class="form-label">${t('Drug sale licence no.')}</label><input name="licenseNo" class="form-control" value="${esc(s.business.licenseNo)}" ${ro}></div>
        <div class="col-6"><label class="form-label">${t('Qualified person / pharmacist')}</label><input name="pharmacist" class="form-control" value="${esc(s.business.pharmacist)}" ${ro}></div>
        <div class="col-8"><label class="form-label">${t('Receipt footer')}</label><input name="footer" class="form-control" value="${esc(s.business.footer)}" ${ro}></div>
        <div class="col-4"><label class="form-label">${t('Currency')}</label><input name="currency" class="form-control" maxlength="5" value="${esc(s.currency)}" ${ro}></div>
        ${manage ? `<div class="col-12"><button class="btn btn-primary">${t('Save')}</button></div>` : ''}</form>`)}
      ${section(t('Pharmacy rules'), 'sliders', `<form class="f-rules row g-2">
        <div class="col-6"><label class="form-label">${t('Warn about expiry within (days)')}</label><input name="expiryAlertDays" class="form-control" inputmode="numeric" value="${s.expiryAlertDays}" ${ro}></div>
        <div class="col-6"><label class="form-label">${t('Order stock for (days of sales)')}</label><input name="orderDays" class="form-control" inputmode="numeric" value="${s.orderDays}" ${ro}></div>
        ${sw('rxRequireDetails', 's-rx', t('Ask patient & doctor name for every prescription medicine'), s.rxRequireDetails, ro)}
        ${sw('receiptShowBatch', 's-rb', t('Print batch and expiry on the receipt'), s.receiptShowBatch, ro)}
        ${sw('receiptShowDirections', 's-rd', t('Print dosage directions on the receipt'), s.receiptShowDirections, ro)}
        ${sw('syncSalePrice', 's-sync', t('When a purchase brings a new MRP, change the sale price too'), s.syncSalePrice, ro)}
        ${sw('updatePurchasePrice', 's-upp', t('Update cost price from the latest purchase'), s.updatePurchasePrice, ro)}
        ${sw('taxEnabled', 's-tax', t('Charge sales tax'), s.taxEnabled, ro)}
        <div class="col-6"><label class="form-label">${t('Tax rate (%)')}</label><input name="taxRate" class="form-control" inputmode="decimal" value="${s.taxRate}" ${ro}></div>
        <div class="col-12 small text-body-secondary mt-2">${t('Document number prefixes (use a different prefix on each device if several devices sell at the same time)')}</div>
        ${[['sale', 'Sale'], ['purchase', 'Purchase'], ['saleReturn', 'Sale return'], ['purchaseReturn', 'Purchase return'], ['receipt', 'Receipt'], ['payment', 'Payment'], ['transfer', 'Transfer'], ['adjustment', 'Adjustment']]
          .map(([k, l]) => `<div class="col-6 col-md-3"><label class="form-label small">${t(l)}</label><input name="p_${k}" class="form-control form-control-sm" maxlength="12" value="${esc(P[k])}" ${ro} pattern="[A-Za-z0-9]+"></div>`).join('')}
        ${manage ? `<div class="col-12"><button class="btn btn-primary">${t('Save')}</button></div>` : ''}</form>`)}
      ${section(t('Appearance'), 'palette', `<select class="form-select f-theme"><option value="auto">${t('Follow device')}</option><option value="light">${t('Light')}</option><option value="dark">${t('Dark')}</option></select>`)}
    </div><div class="col-lg-6">
      ${section(t('Receipt printer'), 'printer', `
        <div class="alert ${cap.webBluetooth ? 'alert-info' : 'alert-secondary'} small py-2">${esc(cap.note)}</div>
        <form class="f-printer row g-2">
          <div class="col-12"><label class="form-label">${t('Print method')}</label><select name="method" class="form-select">
            <option value="browser" ${s.printer.method === 'browser' ? 'selected' : ''}>${t('Browser print dialog (any printer, PDF, AirPrint)')}</option>
            <option value="bluetooth" ${s.printer.method === 'bluetooth' ? 'selected' : ''} ${cap.webBluetooth ? '' : 'disabled'}>${t('Bluetooth ESC/POS printer (Web Bluetooth, BLE)')}${cap.webBluetooth ? '' : ' — ' + t('not supported here')}</option>
            <option value="rawbt" ${s.printer.method === 'rawbt' ? 'selected' : ''}>${t('RawBT app (Android, Classic Bluetooth printers)')}</option></select></div>
          <div class="col-6"><label class="form-label">${t('Paper width')}</label><select name="width" class="form-select"><option value="58" ${s.printer.width == 58 ? 'selected' : ''}>58 mm (32 chars)</option><option value="80" ${s.printer.width == 80 ? 'selected' : ''}>80 mm (48 chars)</option></select></div>
          <div class="col-6"><label class="form-label">${t('Copies')}</label><input name="copies" type="number" min="1" max="5" class="form-control" value="${s.printer.copies || 1}"></div>
          <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="autoPrint" id="s-ap" ${s.printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="s-ap">${t('Print receipt automatically after each sale')}</label></div></div>
        </form>
        <div class="bt-box mt-3 ${s.printer.method === 'bluetooth' ? '' : 'd-none'}">
          <div class="d-flex align-items-center gap-2 mb-2"><i class="bi bi-bluetooth"></i><span class="bt-status small flex-grow-1"></span></div>
          <div class="d-flex gap-2"><button class="btn btn-outline-primary btn-bt-connect">${t('Connect printer')}</button><button class="btn btn-outline-secondary btn-bt-disconnect">${t('Disconnect')}</button></div>
          <label class="form-label mt-3">${t('Transfer speed')}</label>
          <select class="form-select f-chunk">${Object.entries(Printer.CHUNK_SIZES).map(([v, l]) => `<option value="${v}" ${Number(s.printer.chunkSize || 20) === Number(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="form-text">${t('If receipts come out cut off or garbled, choose Safe.')}</div>
        </div>
        <div class="rawbt-box small text-body-secondary mt-2 ${s.printer.method === 'rawbt' ? '' : 'd-none'}">${t('Install the free RawBT app from Google Play, pair your printer in RawBT, then print from here.')}</div>
        <div class="img-box mt-3 ${s.printer.method === 'browser' ? 'd-none' : ''}">
          <label class="form-label">${t('Urdu printing mode')}</label>
          <select class="form-select f-imgmode">
            <option value="gsv0" ${s.printer.imageMode !== 'escstar' ? 'selected' : ''}>Standard (GS v 0) — ${t('most printers')}</option>
            <option value="escstar" ${s.printer.imageMode === 'escstar' ? 'selected' : ''}>Compatibility (ESC *) — ${t('older printers')}</option></select>
          <div class="form-text">${t('Urdu is printed as an image. If Test print shows blank space or garbage where Urdu should be, switch to Compatibility.')}</div>
        </div>
        <button class="btn btn-outline-secondary mt-3 btn-test"><i class="bi bi-printer me-1"></i>${t('Test print (incl. Urdu)')}</button>`)}
      ${section(t('My account'), 'person-circle', `<div class="mb-2"><b>${esc(u.username)}</b><div class="small text-body-secondary">${esc(t(Auth.ROLES[u.role] || u.role))}</div></div>
        <div class="small">${t('Session valid until')} <b>${esc(fmtDateTime(new Date(Auth.expiresAt()).toISOString()))}</b>. ${t('After that, sign in again while online.')}</div>
        <div class="small mt-1">${t('Device ID')}: <code class="user-select-all">${esc(Auth.deviceId())}</code></div>
        <div class="form-text">${t('This account is linked to this device. To move it to another phone or change the password, call')} ${esc(CONFIG.SUPPORT_PHONE)}.</div>`)}
      ${section(t('App & data'), 'phone', `<div class="small mb-2">${t('Version')} ${esc(CONFIG.APP_VERSION)} · <span class="storage-info">…</span></div>
        <div class="d-flex flex-wrap gap-2">
          <button class="btn btn-outline-secondary btn-install d-none"><i class="bi bi-download me-1"></i>${t('Install app')}</button>
          ${Auth.can('product.edit') ? `<button class="btn btn-outline-primary btn-starter"><i class="bi bi-magic me-1"></i>${t('Add popular Pakistani medicines')}</button>` : ''}
          ${manage ? `<button class="btn btn-outline-secondary btn-integrity"><i class="bi bi-shield-check me-1"></i>${t('Check data integrity')}</button><button class="btn btn-outline-secondary btn-rebuild"><i class="bi bi-arrow-repeat me-1"></i>${t('Recalculate stock')}</button>` : ''}
        </div>
        <div class="d-flex align-items-center gap-2 mt-3"><i class="bi bi-camera"></i><span class="small flex-grow-1">${t('Camera for barcode scanning')}: <b class="cam-state">…</b></span>
          <button class="btn btn-sm btn-outline-secondary btn-cam-test">${t('Test camera')}</button></div>
        <div class="cam-help mt-2"></div>
        <div class="small text-body-secondary mt-2 ios-hint d-none">${t('On iPhone/iPad: tap Share → Add to Home Screen to install.')}</div>`)}
    </div></div>`);

    $el.find('.f-theme').val(s.theme).on('change', function () { saveSettings({ theme: this.value }); });
    $el.on('click', '.btn-lang', function () {
      setLang(this.dataset.l);
      location.reload();
    });
    $el.on('submit', '.f-business', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      if (!v.name.trim()) return UI.toast(t('Pharmacy name is required'), 'warning');
      saveSettings({ business: { name: v.name.trim(), nameUr: v.nameUr.trim(), address: v.address.trim(), phone: v.phone.trim(), taxNo: v.taxNo.trim(), licenseNo: v.licenseNo.trim(), pharmacist: v.pharmacist.trim(), footer: v.footer.trim() }, currency: v.currency.trim() || 'Rs' });
      UI.toast(t('Saved'));
    });
    $el.on('submit', '.f-rules', (e) => {
      e.preventDefault();
      const f = e.target; const v = Object.fromEntries(new FormData(f).entries());
      const rate = num(v.taxRate);
      if (rate < 0 || rate > 100) return UI.toast(t('Tax rate must be between 0 and 100'), 'warning');
      const prefixes = {};
      for (const k of Object.keys(P)) {
        const p = String(v['p_' + k] || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{1,12}$/.test(p)) return UI.toast(`Invalid prefix for ${k}. Use letters and digits only.`, 'warning');
        prefixes[k] = p;
      }
      saveSettings({ taxEnabled: f.taxEnabled.checked, taxRate: rate, updatePurchasePrice: f.updatePurchasePrice.checked, syncSalePrice: f.syncSalePrice.checked,
        rxRequireDetails: f.rxRequireDetails.checked, receiptShowBatch: f.receiptShowBatch.checked, receiptShowDirections: f.receiptShowDirections.checked,
        expiryAlertDays: Math.max(1, Math.floor(num(v.expiryAlertDays, 90))), orderDays: Math.max(1, Math.floor(num(v.orderDays, 15))), prefixes });
      UI.toast(t('Saved'));
    });
    const btStatus = () => $el.find('.bt-status').text(Printer.isConnected() ? `${t('Connected')}: ${Printer.connectedName()}` : getSettings().printer.deviceName ? `${t('Not connected')} (${getSettings().printer.deviceName})` : t('No printer connected'));
    btStatus();
    const onPrinter = () => btStatus();
    document.addEventListener('printer:changed', onPrinter);
    this._off = () => document.removeEventListener('printer:changed', onPrinter);
    $el.on('change', '.f-printer', (e) => {
      const f = e.currentTarget;
      const copies = Math.max(1, Math.min(5, parseInt(f.copies.value, 10) || 1));
      saveSettings({ printer: { method: f.method.value, width: Number(f.width.value), autoPrint: f.autoPrint.checked, copies } });
      $el.find('.bt-box').toggleClass('d-none', f.method.value !== 'bluetooth');
      $el.find('.rawbt-box').toggleClass('d-none', f.method.value !== 'rawbt');
      $el.find('.img-box').toggleClass('d-none', f.method.value === 'browser');
    });
    $el.on('change', '.f-imgmode', function () { saveSettings({ printer: { imageMode: this.value } }); UI.toast(t('Saved')); });
    $el.on('change', '.f-chunk', function () { saveSettings({ printer: { chunkSize: Number(this.value) } }); UI.toast(t('Saved')); });
    $el.on('click', '.btn-bt-connect', async () => { try { const n = await Printer.connectBluetooth(); UI.toast(`${t('Connected')}: ${n || 'printer'}`); } catch (e) { UI.toastError(e); } btStatus(); });
    $el.on('click', '.btn-bt-disconnect', () => { Printer.disconnect(); btStatus(); });
    const camState = async () => {
      const st = await Scanner.cameraPermission();
      $el.find('.cam-state').text({ granted: t('Allowed'), denied: t('Blocked'), prompt: t('Not asked yet'), unknown: t('Unknown') }[st] || st)
        .attr('class', `cam-state text-${st === 'granted' ? 'success' : st === 'denied' ? 'danger' : 'body'}`);
      $el.find('.cam-help').html(Scanner.inAppBrowser() ? Scanner.cameraHelpHTML('inapp') : st === 'denied' ? Scanner.cameraHelpHTML('site') : '');
    };
    camState();
    $el.on('click', '.btn-cam-test', async () => {
      const code = await Scanner.scan({ title: t('Test camera') });
      if (code) UI.toast(`${t('Camera works — read')} ${code}`);
      camState();
    });
    $el.on('click', '.btn-test', async () => { try { await Printer.testPrint(); } catch (e) { UI.toastError(e); } });
    $el.on('click', '.btn-starter', async () => { const { importStarterCatalog } = await import('./starter.js'); await importStarterCatalog(); });
    const { canInstall, promptInstall } = await import('../app.js');
    if (canInstall()) $el.find('.btn-install').removeClass('d-none').on('click', promptInstall);
    if (Printer.capabilities().ios && !window.matchMedia('(display-mode: standalone)').matches) $el.find('.ios-hint').removeClass('d-none');
    if (navigator.storage?.estimate) {
      const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
      $el.find('.storage-info').text(`${(est.usage / 1048576).toFixed(1)} MB ${t('used')} · ${persisted ? t('storage persistent') : t('storage best-effort')}`);
    } else $el.find('.storage-info').text('');
    $el.on('click', '.btn-integrity', async () => {
      const r = await UI.withLoading(() => Posting.integrityCheck(), t('Checking…'));
      await UI.confirmDialog(`<p>${r.checked.entries} ledger entries, ${r.checked.stockMoves} stock movements, ${r.checked.batches} batches, ${r.checked.products} medicines checked.</p>${r.issues.length ? `<div class="alert alert-warning small">${r.issues.slice(0, 50).map(esc).join('<br>')}</div>` : `<div class="alert alert-success mb-0">${t('No problems found.')}</div>`}`, { html: true, title: t('Data integrity'), okLabel: 'OK' });
    });
    $el.on('click', '.btn-rebuild', async () => {
      try {
        const fixed = await UI.withLoading(() => Posting.rebuildStock(), t('Recalculating…'));
        UI.toast(fixed.length ? `${t('Corrected stock for')} ${fixed.length}` : t('All stock quantities already match the stock ledger'), fixed.length ? 'warning' : 'success');
      } catch (e) { UI.toastError(e); }
    });
  },
  destroy() { this._off?.(); this._off = null; },
};
