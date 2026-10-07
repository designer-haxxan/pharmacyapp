// Login link helper: https://app/#u=<user>&p=<password> pre-fills the login form (fragment is never sent to a server).
// Runs before the router. The credentials are removed from the address bar immediately and never stored or logged.
(function () {
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var u = params.get('u'); var p = params.get('p');
  if (u === null || p === null) return;
  history.replaceState(null, '', location.pathname + location.search);
  var tries = 0;
  (function fill() {
    var user = document.getElementById('login-username'); var pass = document.getElementById('login-password');
    var btn = document.getElementById('login-btn');
    if (!user || !pass || !btn) { if (++tries < 100) setTimeout(fill, 100); return; }
    // Already signed in: the login form is hidden, so do nothing.
    if (!document.getElementById('view-login') || document.getElementById('view-login').classList.contains('d-none')) { if (++tries < 100) { setTimeout(fill, 100); } return; }
    user.value = u; pass.value = p;
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    u = p = null;
    var hint = document.createElement('div');
    hint.className = 'autofill-hint'; hint.setAttribute('dir', 'rtl'); hint.setAttribute('data-no-i18n', '');
    hint.textContent = 'یوزر نیم اور پاس ورڈ خود بخود بھر دیے گئے ہیں۔ بس لاگ ان دبائیں';
    btn.parentNode.insertBefore(hint, btn);
    btn.classList.add('btn-attention');
  })();
})();
