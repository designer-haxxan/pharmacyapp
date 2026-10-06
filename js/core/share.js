// Sharing helpers: WhatsApp links (very common with suppliers in Pakistan) and plain-text lists.
export function waNumber(phone) {
  let d = String(phone || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '92' + d.slice(1);
  return d;
}
export function waUrl(phone, text) {
  const n = waNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
export function openWhatsApp(phone, text) {
  window.open(waUrl(phone, text), '_blank', 'noopener');
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
