/* Apply saved appearance prefs before first paint to avoid a flash of the wrong
   colors / size / motion. Theme, forced reduce-motion, and display zoom. */
try {
  const _s = JSON.parse(localStorage.getItem('sayitSettings') || '{}');
  const _de = document.documentElement;
  if (_s.theme === 'dim' || _s.theme === 'light') _de.setAttribute('data-theme', _s.theme);
  if (_s.reduceMotion) _de.classList.add('force-reduce-motion');
  if (_s.displayZoom && String(_s.displayZoom) !== '1') _de.style.zoom = _s.displayZoom;
} catch (e) {}
