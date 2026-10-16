// Reusable controls: metal buttons, toggles, menus, dialogs, toasts,
// tooltips. Everything that should catch the sheen carries .metal.
import { h, append } from './dom.js';
import { icon, pixelSpinner } from './icons.js';
import { t } from './i18n.js';
import { remote } from './core.js';

// ---- buttons -----------------------------------------------------------------
export function button(label, opts = {}) {
  const { variant = 'secondary', icon: ic, iconRight, onClick, title, cls, disabled, size, type = 'button' } = opts;
  const el = h(
    `button.btn.metal.${variant}`,
    { type, class: [cls, size ? `btn-${size}` : ''].filter(Boolean).join(' '), disabled: !!disabled, 'data-tip': title || null },
    ic ? icon(ic) : null,
    label != null && label !== '' ? h('span.btn-label', label) : null,
    iconRight ? icon(iconRight) : null,
  );
  if (onClick) el.addEventListener('click', (e) => onClick(e, el));
  return el;
}

export function iconButton(name, opts = {}) {
  return button(null, { ...opts, icon: name, cls: [opts.cls, 'btn-icon'].filter(Boolean).join(' ') });
}

export function setButtonLabel(btn, text) {
  const span = btn.querySelector('.btn-label');
  if (span) span.textContent = text;
}

// ---- form controls -------------------------------------------------------------
export function toggle(checked, onChange, { disabled } = {}) {
  const el = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': String(!!checked), disabled: !!disabled }, h('span.toggle-knob'));
  el.classList.toggle('on', !!checked);
  el.addEventListener('click', () => {
    const v = !el.classList.contains('on');
    el.classList.toggle('on', v);
    el.setAttribute('aria-checked', String(v));
    onChange && onChange(v);
  });
  el.setValue = (v) => {
    el.classList.toggle('on', !!v);
    el.setAttribute('aria-checked', String(!!v));
  };
  return el;
}

export function toggleRow(title, hint, checked, onChange, opts) {
  const sw = toggle(checked, onChange, opts);
  const row = h('label.toggle-row', h('div.toggle-text', h('div.toggle-title', title), hint ? h('div.hint', hint) : null), sw);
  row.addEventListener('click', (e) => {
    if (e.target !== sw && !sw.contains(e.target)) {
      e.preventDefault();
      sw.click();
    }
  });
  row.toggle = sw;
  return row;
}

export function segmented(options, value, onChange) {
  const el = h('div.segmented');
  const set = (v) => {
    for (const b of el.children) b.classList.toggle('active', b.dataset.value === v);
  };
  for (const o of options) {
    const b = h('button.seg', { type: 'button', dataset: { value: o.value }, 'data-tip': o.tip || null }, o.icon ? icon(o.icon) : null, o.label ? h('span', o.label) : null);
    b.addEventListener('click', () => {
      if (b.classList.contains('active')) return;
      set(o.value);
      onChange && onChange(o.value);
    });
    el.appendChild(b);
  }
  set(value);
  el.setValue = set;
  return el;
}

export function input(opts = {}) {
  const el = h('input.input', {
    type: opts.type || 'text',
    placeholder: opts.placeholder || '',
    value: opts.value ?? '',
    maxLength: opts.maxLength || null,
    spellcheck: false,
    min: opts.min ?? null,
    max: opts.max ?? null,
    step: opts.step ?? null,
  });
  if (opts.onInput) el.addEventListener('input', () => opts.onInput(el.value, el));
  if (opts.onEnter) el.addEventListener('keydown', (e) => e.key === 'Enter' && opts.onEnter(el.value, el));
  return el;
}

export function searchBox(opts = {}) {
  const inp = input(opts);
  inp.classList.add('search-input');
  return h('div.search', icon('search', { cls: 'search-icon' }), inp);
}

export function field(label, control, hint) {
  return h('div.field', label ? h('div.label', label) : null, control, hint ? h('div.hint', hint) : null);
}

export function slider({ min, max, step, value, onInput, onChange, format, marks }) {
  const range = h('input.slider', { type: 'range', min, max, step, value });
  const out = h('div.slider-value', format ? format(value) : String(value));
  const paint = () => {
    const p = ((range.value - min) / (max - min)) * 100;
    range.style.setProperty('--p', `${p}%`);
    out.textContent = format ? format(Number(range.value)) : range.value;
  };
  range.addEventListener('input', () => {
    paint();
    onInput && onInput(Number(range.value));
  });
  range.addEventListener('change', () => onChange && onChange(Number(range.value)));
  paint();
  const wrap = h('div.slider-wrap', range, out);
  if (marks) {
    const row = h('div.slider-marks');
    for (const m of marks) {
      row.appendChild(h('span.mark', { style: { left: `${((m.value - min) / (max - min)) * 100}%` }, class: m.cls || '' }, m.label));
    }
    wrap.appendChild(row);
  }
  wrap.range = range;
  return wrap;
}

// The loading indicator: Minecraft's pixel arc going round.
export function spinner(size = 'md') {
  return pixelSpinner(size);
}

export function emptyState(ic, title, text, ...actions) {
  return h('div.empty', ic ? h('div.empty-icon', icon(ic, { scale: 4 })) : null, title ? h('div.empty-title', title) : null, text ? h('div.empty-text', text) : null, actions.length ? h('div.empty-actions', ...actions) : null);
}

// ---- dropdown menu ------------------------------------------------------------------
let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

// items: [{label, icon, onClick, danger, disabled, checked, separator, hint}]
export function showMenu(anchor, items, { align = 'right', x, y, minWidth } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      menu.appendChild(h('div.menu-sep'));
      continue;
    }
    if (it.header) {
      menu.appendChild(h('div.menu-header', it.header));
      continue;
    }
    const row = h(
      'button.menu-item',
      { type: 'button', disabled: !!it.disabled, class: [it.danger ? 'danger' : '', it.checked ? 'checked' : ''].join(' ') },
      h('span.menu-ic', it.icon ? icon(it.icon) : it.checked ? icon('check') : null),
      h('span.menu-label', it.label),
      it.hint ? h('span.menu-hint', it.hint) : null,
    );
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      it.onClick && it.onClick();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  const mr = menu.getBoundingClientRect();
  let left;
  let top;
  if (typeof x === 'number') {
    left = x;
    top = y;
  } else {
    const r = anchor.getBoundingClientRect();
    left = align === 'right' ? r.right - mr.width : align === 'stretch' ? r.left : r.left;
    if (align === 'stretch') menu.style.minWidth = `${r.width}px`;
    top = r.bottom + 6;
    if (top + mr.height > window.innerHeight - 8) top = r.top - mr.height - 6;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - mr.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - mr.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenu = menu;
  requestAnimationFrame(() => menu.classList.add('open'));
  return menu;
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
// The menu stands where it was opened: once the page under it scrolls away it
// would point at nothing, so it closes. (Scroll doesn't bubble — caught on its
// way down; a long menu scrolling inside itself stays.)
document.addEventListener('scroll', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// A select-like control built on the menu.
export function dropdown(options, value, onChange, { placeholder = '', disabled = false, cls } = {}) {
  let current = value;
  const label = h('span.dd-label');
  const el = h('button.dropdown', { type: 'button', disabled, class: cls || '' }, label, icon('down', { cls: 'dd-caret' }));
  const render = () => {
    const o = options.find((x) => x.value === current);
    label.textContent = o ? o.label : placeholder;
    label.classList.toggle('placeholder', !o);
  };
  el.addEventListener('click', () => {
    showMenu(
      el,
      options.map((o) => ({ label: o.label, hint: o.hint, checked: o.value === current, onClick: () => {
        current = o.value;
        render();
        onChange && onChange(o.value);
      } })),
      { align: 'stretch' },
    );
  });
  el.setOptions = (opts, v) => {
    options = opts;
    current = v;
    render();
  };
  el.setValue = (v) => {
    current = v;
    render();
  };
  el.getValue = () => current;
  render();
  return el;
}

// ---- dialogs ------------------------------------------------------------------------
export function modal({ title, body, buttons = [], width = 440, onClose, cls }) {
  const overlay = h('div.overlay');
  const card = h('div.dialog', { style: { width: `${width}px` }, class: cls || '' }, title ? h('div.dialog-title', title) : null, h('div.dialog-body', body));
  const actions = h('div.dialog-actions');
  const close = (value) => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener('keydown', onKey);
    onClose && onClose(value);
  };
  // Escape closes the top dialog only (a confirm over the party dialog)
  const onKey = (e) => {
    if (e.key === 'Escape' && overlay === [...document.querySelectorAll('.overlay')].pop()) close(undefined);
  };
  for (const b of buttons) {
    actions.appendChild(button(b.label, { variant: b.variant || 'secondary', onClick: () => (b.onClick ? b.onClick(close) : close(b.value)) }));
  }
  if (buttons.length) card.appendChild(actions);
  overlay.appendChild(card);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close(undefined);
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  return { close, card };
}

export function confirmDialog(title, text, { ok = t('common.delete'), danger = true } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p.dialog-text', text),
      buttons: [
        { label: t('common.cancel'), value: false },
        { label: ok, value: true, variant: danger ? 'danger' : 'primary' },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

// ---- toasts -------------------------------------------------------------------------
let toastHost = null;

// kind sets the colour: ok, warn, error, info, and for news from people
// invite (lobbies, parties), online (friends), request (friend requests),
// party. icon overrides the kind's picture; avatar (a gamer pic, or with
// pixel a skin's 8x8 face) takes its place with the icon as a badge; title
// goes above the text.
const KIND_ICON = { error: 'warning', warn: 'warning', ok: 'check', info: 'info', invite: 'mail', online: 'lamp', request: 'userPlus', party: 'friends', message: 'chat' };

export function toast(text, { kind = 'info', icon: ic, avatar, pixel, title, action, actions, timeout } = {}) {
  if (!toastHost) {
    toastHost = h('div.toasts');
    document.body.appendChild(toastHost);
  }
  const name = ic || KIND_ICON[kind] || 'info';
  let pic;
  if (avatar) {
    const img = h(`img.toast-avatar${pixel ? '.px' : ''}`, { src: /^https?:/.test(avatar) ? remote(avatar) : avatar, alt: '' });
    pic = h('div.toast-ic.has-avatar', img, h('span.toast-badge', icon(name, { scale: 1 })));
    // no picture after all: the tile instead
    img.addEventListener('error', () => pic.replaceWith(h('div.toast-ic', icon(name))), { once: true });
  } else {
    pic = h('div.toast-ic', icon(name));
  }
  const body = h('div.toast-text', title ? h('div.toast-title', title) : null, text);
  const el = h(`div.toast.${kind}`, pic, body);
  // action: one button; actions: several, stacked (e.g. let in / decline)
  const list = actions || (action ? [action] : []);
  const box = list.length > 1 ? h('div.toast-actions') : el;
  for (const a of list) {
    const b = h('button.toast-action', { type: 'button' }, a.label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      a.onClick();
      dismiss();
    });
    box.appendChild(b);
  }
  if (box !== el) el.appendChild(box);
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener('click', dismiss);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(dismiss, timeout || (kind === 'error' ? 9000 : 5000));
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
}

// ---- tooltips (data-tip) ---------------------------------------------------------------
let tipEl = null;
let tipTimer = 0;
let tipTarget = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipEl) tipEl.classList.remove('show');
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest && e.target.closest('[data-tip]');
  if (target === tipTarget) return;
  hideTip();
  if (!target || !target.dataset.tip) return;
  tipTarget = target;
  tipTimer = setTimeout(() => {
    if (!tipTarget || !document.body.contains(tipTarget)) return;
    if (!tipEl) {
      tipEl = h('div.tooltip');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = tipTarget.dataset.tip;
    const r = tipTarget.getBoundingClientRect();
    tipEl.style.left = '0px';
    tipEl.style.top = '0px';
    tipEl.classList.add('show');
    const tr = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    let top = r.bottom + 8;
    if (top + tr.height > window.innerHeight - 6) top = r.top - tr.height - 8;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }, 450);
});
document.addEventListener('mousedown', hideTip);
window.addEventListener('blur', hideTip);

export { h, append };
