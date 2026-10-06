// One-tap import of common Pakistani medicines (names, salts, companies - no prices, no stock).
import * as UI from '../core/ui.js';
import { esc } from '../core/utils.js';
import { t } from '../core/i18n.js';
import * as Posting from '../services/posting.js';
import { STARTER } from '../data/catalog-pk.js';

export async function importStarterCatalog() {
  const ok = await UI.confirmDialog(
    `<p class="mb-2">${t('This adds about')} <b>${STARTER.length}</b> ${t('common medicines and supplies to your list so you do not have to type them.')}</p>
     <ul class="small mb-2"><li>${t('Medicines you already have are not duplicated.')}</li><li>${t('No prices and no stock are added. The MRP is filled in automatically the first time you enter a purchase.')}</li><li>${t('Pack sizes are typical — correct any that differ from your packs.')}</li></ul>`,
    { html: true, title: t('Add popular Pakistani medicines'), okLabel: t('Add medicines') });
  if (!ok) return false;
  try {
    const r = await UI.withLoading(() => Posting.bulkAddProducts(STARTER), t('Adding medicines…'));
    UI.toast(`${r.added} ${t('medicines added')}${r.skipped ? `, ${r.skipped} ${t('already existed')}` : ''}`);
    return true;
  } catch (e) { UI.toastError(e); return false; }
}
export { esc };
