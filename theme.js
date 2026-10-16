// MC Launcher site: the page's colour — one of the launcher's own accent
// colours (its dye palette, muted the launcher's way), picked at random on every
// visit and never the same twice in a row. Runs in <head>, before the first
// paint; ?theme=<name> picks one. The hero's screenshot is the launcher in that
// same colour (assets/shots/lobby-<name>.webp).
(function () {
  'use strict';
  var THEMES = {
    emerald: '#4caf50', lightblue: '#50a8c4', cyan: '#2e8a8a', blue: '#3c44aa', purple: '#863ab0',
    magenta: '#c550bb', pink: '#c75778', red: '#a03c36', orange: '#c58551',
  };
  var names = Object.keys(THEMES);

  var asked = (/[?&]theme=([a-z]+)/.exec(location.search) || [])[1];
  var last = null;
  try { last = localStorage.getItem('mcl-theme'); } catch (e) { /* no storage: any colour */ }
  var name = THEMES[asked] ? asked : null;
  if (!name) {
    var pool = names.filter(function (n) { return n !== last; });
    name = pool[Math.floor(Math.random() * pool.length)];
  }
  try { localStorage.setItem('mcl-theme', name); } catch (e) { /* fine */ }

  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, l];
  }
  function hex(h, s, l) {
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    function f(n) {
      var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      var c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return ('0' + Math.round(c * 255).toString(16)).slice(-2);
    }
    return '#' + f(0) + f(8) + f(4);
  }
  var trip = function (h) { return rgb(h).join(', '); };

  // the shades, worked out from the colour as the launcher does (for emerald
  // they come out as the site's original greens)
  var base = THEMES[name];
  var t = hsl(rgb(base)), H = t[0], S = Math.min(1, t[1] * 1.12), L = t[2];
  var line = hex(H, S * 1.05, Math.min(0.78, L + 0.17));
  var glow = hex(H, S * 1.25, Math.min(0.7, L + 0.12));
  var vars = {
    '--acc': base,
    '--acc-hi': hex(H, S, Math.min(0.82, L + 0.07)),
    '--acc-line': line,
    '--acc-line-hi': hex(H, Math.max(0.5, S * 1.3), 0.78),
    '--acc-deep': hex(H, S, Math.max(0.1, L - 0.29)),
    '--acc-text': hex(H, Math.min(1, S * 1.35), Math.max(0.7, Math.min(0.78, L + 0.24))),
    '--acc-rgb': trip(base),
    '--acc-line-rgb': trip(line),
    '--acc-glow-rgb': trip(glow),
    '--hero-1': hex(H, Math.min(0.32, S * 0.8), 0.175),
    '--hero-2': hex(H, Math.min(0.28, S * 0.7), 0.127),
    '--tint-text': hex(H, 0.6, 0.9),
    '--lead': hex(H, 0.25, 0.914),
    '--meta': hex(H, 0.17, 0.76),
  };
  var root = document.documentElement;
  for (var k in vars) root.style.setProperty(k, vars[k]);
  root.setAttribute('data-theme', name);

  window.MCL_THEME = {
    name: name,
    shot: 'assets/shots/lobby-' + name + '.webp',
    // the hero's particles (assets/js/sky.js)
    sky: { base: base, light: hex(H, S * 1.2, 0.76), dark: hex(H, S, 0.2) },
  };
})();
