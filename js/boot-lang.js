// Runs before first paint: applies the saved language (English / Urdu) so there is no flash of the wrong layout.
(function () {
  try {
    var ur = localStorage.getItem('shifarx.lang') === 'ur';
    var h = document.documentElement;
    h.setAttribute('lang', ur ? 'ur' : 'en');
    h.setAttribute('dir', ur ? 'rtl' : 'ltr');
    var ltr = document.getElementById('bs-ltr'); var rtl = document.getElementById('bs-rtl');
    if (ltr) ltr.disabled = ur;
    if (rtl) rtl.disabled = !ur;
  } catch (e) { /* storage unavailable: stay English */ }
})();
