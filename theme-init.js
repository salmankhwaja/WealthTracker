/* Applies the saved theme before first paint (loaded in <head>; CSP disallows inline scripts). */
(function () {
  try {
    var t = localStorage.getItem('pkw-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
