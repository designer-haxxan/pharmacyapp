// Backup & Restore UI.
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, downloadFile } from '../core/utils.js';
import { pref } from '../core/settings.js';
import { t } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Backup from '../services/backup.js';

const $ = window.jQuery;

export async function downloadBackup() {
  const b = await UI.withLoading(() => Backup.createBackup(), t('Preparing backup…'));
  const stamp = b.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  downloadFile(`shifa-pharmacy-backup-${stamp}.json`, JSON.stringify(b), 'application/json');
  pref.set('lastBackupAt', b.createdAt);
  return b;
}

const LABELS = {
  products: 'Medicines', batches: 'Batches', categories: 'Groups', customers: 'Customers', suppliers: 'Suppliers', accounts: 'Accounts', sales: 'Sales', saleItems: 'Sale items',
  purchases: 'Purchases', purchaseItems: 'Purchase items', saleReturns: 'Sale returns', purchaseReturns: 'Purchase returns', vouchers: 'Payments / vouchers',
  entries: 'Ledger entries', stockMoves: 'Stock movements', adjustments: 'Stock adjustments', demands: 'Order list', holds: 'Held sales', auditLog: 'Activity log', meta: 'Counters / metadata',
};

export default {
  async render(el) {
    const $el = $(el).off();
    const canRestore = Auth.can('backup.restore');
    const last = pref.get('lastBackupAt');
    $el.html(UI.pageHeader(t('Backup & Restore')) + `
      <div class="help-box mb-3"><i class="bi bi-shield-check"></i><div>${t('Your pharmacy data is stored safely on this phone/computer. Download a backup every week and keep the file in Google Drive or send it to yourself on WhatsApp, so you never lose your records.')}</div></div>
      <div class="row g-3">
        <div class="col-lg-6"><div class="card h-100"><div class="card-body">
          <h2 class="h6"><i class="bi bi-cloud-arrow-down me-2"></i>${t('Export backup')}</h2>
          <p class="small text-body-secondary">${t('Downloads a complete backup file: medicines, batches, customers, suppliers, sales, purchases, returns, payments, ledger and settings. Passwords are never included.')}</p>
          <div class="small mb-3">${t('Last backup on this device')}: <b class="last-b">${last ? fmtDateTime(last) : t('never')}</b></div>
          <button class="btn btn-primary btn-lg btn-export"><i class="bi bi-download me-1"></i>${t('Download backup')}</button>
        </div></div></div>
        <div class="col-lg-6"><div class="card h-100"><div class="card-body">
          <h2 class="h6"><i class="bi bi-cloud-arrow-up me-2"></i>${t('Restore backup')}</h2>
          ${canRestore ? `<p class="small text-body-secondary">${t('Select a backup file. It is checked before anything changes; you will see its date and counts and must confirm.')}</p>
            <input type="file" accept="application/json,.json" class="form-control file">
            <div class="preview mt-3"></div>` : `<div class="alert alert-secondary small mb-0">${t('Only administrators can restore backups.')}</div>`}
        </div></div></div>
      </div>`);
    $el.on('click', '.btn-export', async () => {
      try { const b = await downloadBackup(); UI.toast(t('Backup downloaded')); $el.find('.last-b').text(fmtDateTime(b.createdAt)); } catch (e) { UI.toastError(e); }
    });
    let obj = null;
    $el.on('change', '.file', async function () {
      const f = this.files[0];
      const $p = $el.find('.preview').html(UI.spinner('Validating…'));
      obj = null;
      if (!f) return $p.empty();
      try {
        if (f.size > 500 * 1024 * 1024) throw new Error('File is too large.');
        let parsed;
        try { parsed = JSON.parse(await f.text()); } catch { throw new Error('The file is not valid JSON (it may be corrupted).'); }
        const v = Backup.validateBackup(parsed);
        const sumOk = v.ok ? await Backup.verifyChecksum(parsed) : null;
        if (sumOk === false) v.errors.push('Checksum mismatch: the backup data was modified or corrupted.');
        const ok = v.ok && sumOk !== false;
        $p.html(`<div class="alert ${ok ? 'alert-success' : 'alert-danger'} py-2 small">${ok ? `<i class="bi bi-check-circle me-1"></i>${t('Backup is valid.')}` : `<i class="bi bi-x-octagon me-1"></i>${t('This backup cannot be restored.')}`}
            ${v.errors.map((e) => `<div>• ${esc(e)}</div>`).join('')}${v.warnings.map((w) => `<div class="text-warning-emphasis">• ${esc(w)}</div>`).join('')}</div>
          ${v.counts ? `<div class="small mb-2">${t('Created')}: <b>${esc(fmtDateTime(v.createdAt))}</b> · ${t('App')} ${esc(v.appVersion || '?')}${v.createdBy ? ` · ${t('by')} ${esc(v.createdBy.name)}` : ''}${sumOk ? ` · ${t('checksum verified')}` : ''}</div>
          <div class="list-card mb-3 small">${Object.entries(v.counts).filter(([, n]) => n).map(([k, n]) => `<div class="list-row py-1"><div class="main">${esc(t(LABELS[k] || k))}</div><div class="end">${n}</div></div>`).join('')}</div>` : ''}
          ${ok ? `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="safety" checked><label class="form-check-label small" for="safety">${t('Download a backup of the current data first (recommended)')}</label></div>
          <div class="d-grid gap-2">
            <button class="btn btn-outline-primary btn-merge"><i class="bi bi-intersect me-1"></i>${t('Merge into local data')}</button>
            <button class="btn btn-danger btn-replace"><i class="bi bi-arrow-repeat me-1"></i>${t('Replace all local data')}</button>
          </div>
          <div class="form-text">${t('Merge adds records that are missing and updates records that are newer in the backup. Replace erases all data on this device and loads the backup.')}</div>` : ''}`);
        if (ok) obj = parsed;
      } catch (e) { $p.html(UI.errorState(e)); }
    });
    const doRestore = async (mode) => {
      if (!obj) return;
      const msg = mode === 'replace'
        ? `<p>${t('This will erase all data on this device and replace it with the backup. This cannot be undone.')}</p><label class="form-label small">${t('Type REPLACE to confirm')}</label><input class="form-control confirm-text">`
        : `<p>${t('Records from the backup will be merged into the local data. Existing newer records are kept.')}</p>`;
      let typed = '';
      const m = UI.confirmDialog(msg, { html: true, okLabel: mode === 'replace' ? t('Replace data') : t('Merge'), okClass: mode === 'replace' ? 'btn-danger' : 'btn-primary', title: mode === 'replace' ? t('Replace all data?') : t('Merge backup?') });
      $(document).on('input.confirmtext', '.confirm-text', function () { typed = this.value; });
      const ok = await m;
      $(document).off('input.confirmtext');
      if (!ok) return;
      if (mode === 'replace' && typed.trim().toUpperCase() !== 'REPLACE') { UI.toast(t('Restore cancelled: confirmation text did not match.'), 'warning'); return; }
      try {
        if ($el.find('#safety').prop('checked')) await downloadBackup();
        const r = await UI.withLoading(() => Backup.restore(obj, mode), t('Restoring data…'));
        UI.toast(mode === 'replace' ? t('Backup restored') : `${t('Merged')}: ${r.added} ${t('added')}, ${r.updated} ${t('updated')}, ${r.skipped} ${t('unchanged')}`);
        if (r.conflicts.length) await UI.confirmDialog(`<p>${r.conflicts.length} record(s) were skipped because of number conflicts:</p><div class="small">${r.conflicts.slice(0, 30).map(esc).join('<br>')}</div>`, { html: true, title: t('Merge conflicts'), okLabel: 'OK' });
        location.hash = '#/dashboard';
      } catch (e) { UI.toastError(e); }
    };
    $el.on('click', '.btn-merge', () => doRestore('merge'));
    $el.on('click', '.btn-replace', () => doRestore('replace'));
  },
};
