// Prescription & controlled-drug register: every Rx / controlled medicine sold, with patient, doctor and batch (for inspections).
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtDate, today, monthStart, toCSV, downloadFile } from '../core/utils.js';
import { dateFilter, bindDateFilter } from '../core/views.js';
import { t } from '../core/i18n.js';
import { stockText, fmtExpiry } from '../core/pharma.js';
import { getSettings } from '../core/settings.js';
import * as Catalog from '../services/catalog.js';
import { printHTML } from '../printer/printer.js';

const $ = window.jQuery;

async function load(from, to, kind) {
  const range = IDBKeyRange.bound(from, to);
  const [items, sales] = await Promise.all([idb.getAllByIndex('saleItems', 'date', range), idb.getAllByIndex('sales', 'date', range)]);
  const byId = new Map(sales.filter((s) => s.status !== 'void').map((s) => [s.id, s]));
  return items.filter((i) => (kind === 'controlled' ? i.cls === 'controlled' : i.cls === 'rx' || i.cls === 'controlled') && byId.has(i.saleId))
    .map((i) => ({ i, s: byId.get(i.saleId), p: Catalog.product(i.productId) }))
    .sort((a, b) => a.s.date.localeCompare(b.s.date) || a.s.createdAt.localeCompare(b.s.createdAt));
}

export default {
  async render(el) {
    const $el = $(el).off();
    let from = monthStart(); let to = today(); let rows = [];
    $el.html(UI.pageHeader(t('Rx register'), `<button class="btn btn-light btn-sm btn-print"><i class="bi bi-printer"></i><span class="d-none d-sm-inline"> ${t('Print')}</span></button><button class="btn btn-light btn-sm btn-csv"><i class="bi bi-filetype-csv"></i><span class="d-none d-sm-inline"> CSV</span></button>`) +
      `<div class="help-box mb-3"><i class="bi bi-shield-check"></i><div>${t('A record of every prescription and controlled medicine sold. Keep it ready for the drug inspector.')}</div></div>` +
      dateFilter(from, to, `<div><label class="form-label small mb-0">${t('Show')}</label><select name="kind" class="form-select form-select-sm"><option value="rx">${t('All Rx + controlled')}</option><option value="controlled">${t('Controlled only')}</option></select></div>`) + '<div class="card"><div class="table-responsive out"></div></div>');
    const draw = async (kind = $el.find('[name=kind]').val()) => {
      rows = await load(from, to, kind);
      $el.find('.out').html(`<table class="table table-sm table-report mb-0"><thead><tr><th>${t('Date')}</th><th>${t('Invoice')}</th><th>${t('Patient')}</th><th>${t('Doctor')}</th><th>${t('Medicine')}</th><th>${t('Batch')}</th><th class="num">${t('Qty')}</th></tr></thead>
        <tbody>${rows.map(({ i, s, p }) => `<tr><td class="text-nowrap">${fmtDate(s.date)}</td><td><a href="#/sales/${encodeURIComponent(s.id)}">${esc(s.number)}</a></td>
          <td>${esc(s.rx?.patient || s.customerName)}${s.rx?.phone ? `<div class="small text-body-secondary">${esc(s.rx.phone)}</div>` : ''}</td><td>${esc(s.rx?.doctor || '—')}</td>
          <td>${esc(i.name)}${i.strength ? ' ' + esc(i.strength) : ''} ${i.cls === 'controlled' ? `<span class="cls-badge cls-controlled">${t('Controlled')}</span>` : ''}</td><td>${esc(i.batchNo)}<div class="small">${i.expiry ? fmtExpiry(i.expiry) : ''}</div></td><td class="num">${esc(stockText(p, i.baseQty))}</td></tr>`).join('')
          || `<tr><td colspan="7" class="text-center text-body-secondary py-4">${t('No prescription medicines sold in this period')}</td></tr>`}</tbody></table>`);
    };
    bindDateFilter($el, (f, tt, fd) => { from = f; to = tt; draw(fd.kind); });
    $el.on('change', '[name=kind]', () => draw());
    $el.on('click', '.btn-print', () => {
      const b = getSettings().business;
      printHTML(`<div class="print-report"><h2>${esc(b.name)}</h2><div><b>${t('Prescription & controlled drug register')}</b>${b.licenseNo ? ` · ${t('Licence')}: ${esc(b.licenseNo)}` : ''}${b.pharmacist ? ` · ${t('Pharmacist')}: ${esc(b.pharmacist)}` : ''}</div><div>${esc(from)} – ${esc(to)}</div><br>${$el.find('.out').html()}</div>`, { page: 'A4' });
    });
    $el.on('click', '.btn-csv', () => {
      const csv = [['Date', 'Invoice', 'Patient', 'Phone', 'Doctor', 'Medicine', 'Class', 'Batch', 'Expiry', 'Qty (units)'], ...rows.map(({ i, s }) => [s.date, s.number, s.rx?.patient || s.customerName, s.rx?.phone || '', s.rx?.doctor || '', `${i.name} ${i.strength || ''}`.trim(), i.cls, i.batchNo, i.expiry, i.baseQty])];
      downloadFile(`rx-register-${from}_${to}.csv`, '﻿' + toCSV(csv), 'text/csv;charset=utf-8');
    });
    await draw();
  },
};
