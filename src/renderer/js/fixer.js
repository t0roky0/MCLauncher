// The fixer (the bug by the console): what keeps the game from starting,
// for Java (an installation: its last crash, its mods) or Bedrock (a stuck
// game, its crashes, the launcher's module, Gaming Services) — each problem
// with the one click that puts it right, where there is one (src/main/fixer.js).
import { h, swap } from './dom.js';
import { icon } from './icons.js';
import { api, store } from './core.js';
import { button, modal, segmented, spinner, toast } from './ui.js';

let open = null;

export function openFixer() {
  if (open) return;
  const cfg = store.get('config') || {};
  let edition = cfg.selectedInstall === 'bedrock' ? 'bedrock' : 'java';
  const list = h('div.fx-list');
  const head = h('div.fx-head');
  const tabs = segmented([{ value: 'java', label: 'Java' }, { value: 'bedrock', label: 'Bedrock' }], edition, (v) => { edition = v; scan(); });
  const again = button('Проверить снова', { icon: 'refresh', cls: 'btn-sm', onClick: () => scan() });
  const dialog = modal({
    title: 'Починить игру',
    width: 600,
    cls: 'fx-dialog',
    body: [h('div.fx-top', tabs, again), head, list],
    buttons: [{ label: 'Закрыть', value: false }],
    onClose: () => { open = null; },
  });
  open = dialog;

  let token = 0;
  async function scan() {
    const my = ++token;
    swap(head);
    swap(list, h('div.fx-wait', spinner('md'), h('span', edition === 'java' ? 'Смотрю последний вылет и моды…' : 'Смотрю, что мешает Bedrock…')));
    let r;
    try {
      r = await api('fixer:scan', edition);
    } catch (e) {
      if (my === token) swap(list, h('div.fx-empty', e.message));
      return;
    }
    if (my !== token) return;
    render(r);
  }

  function row(p, r) {
    const fixBtn = p.fix ? button(p.fixLabel || 'Исправить', {
      variant: ['open', 'url'].includes(p.fix.kind) ? 'secondary' : 'primary',
      cls: 'btn-sm',
      onClick: async () => {
        fixBtn.disabled = true;
        try {
          const res = await api('fixer:fix', p.fix);
          if (res && res.done) toast(res.done, { kind: 'ok', timeout: 6000 });
          if (!['open', 'url'].includes(p.fix.kind)) scan();
        } catch (e) {
          toast(e.message, { kind: 'error' });
        } finally {
          fixBtn.disabled = false;
        }
      },
    }) : null;
    const bad = !['crash', 'safe'].includes(p.id);
    return h(`div.fx-row${bad ? '.bad' : ''}`, h('span.fx-ic', icon(bad ? 'warning' : 'info')), h('div.fx-text', h('div.fx-title', p.title), p.detail ? h('div.hint', p.detail) : null), fixBtn);
  }

  function render(r) {
    if (r.edition === 'java') {
      swap(head, r.install ? h('div.hint', `Установка «${r.install.name}» — ${r.install.mcVersion}${r.install.loader && r.install.loader !== 'vanilla' ? `, ${r.install.loader}` : ''}`) : null);
      if (!r.install) {
        swap(list, h('div.fx-empty', 'Нет установок Java — нечего проверять.'));
        return;
      }
    } else swap(head, r.version ? h('div.hint', `Minecraft Bedrock ${r.version}`) : null);
    const rows = r.problems.map((p) => row(p, r));
    const real = r.problems.filter((p) => !['crash', 'safe'].includes(p.id));
    const parts = [];
    if (!real.length) {
      parts.push(h('div.fx-ok', icon('check'), h('span', r.edition === 'java' ? 'Ничего, что ломало бы запуск, не нашли.' : 'Ничего, что мешало бы Bedrock, не нашли.')));
      if (r.edition === 'java') {
        parts.push(h('div.hint', 'Если игра всё равно вылетает — проверьте файлы: лаунчер перекачает испорченное.'));
        parts.push(h('div.fx-actions',
          button('Проверить файлы игры', { icon: 'refresh', cls: 'btn-sm', onClick: async () => { try { const res = await api('fixer:fix', { kind: 'verify', install: r.install.id }); toast(res.done, { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'error' }); } } }),
          button('Папка модов', { icon: 'folder', cls: 'btn-sm', onClick: () => api('app:openFolder', 'instance', r.install.id, 'mods').catch(() => {}) })));
      } else parts.push(h('div.hint', 'Если игра не открывается — закройте её в трее Xbox, перезапустите приложение Xbox и попробуйте снова.'));
    }
    parts.push(...rows);
    if (r.edition === 'java' && r.disabled && r.disabled.length) {
      parts.push(h('div.fx-sub', 'Выключенные моды'));
      for (const d of r.disabled) {
        const on = button('Включить', { cls: 'btn-sm', onClick: async () => {
          on.disabled = true;
          try { await api('fixer:fix', { kind: 'enableMod', install: r.install.id, file: d.file }); scan(); } catch (e) { toast(e.message, { kind: 'error' }); on.disabled = false; }
        } });
        parts.push(h('div.fx-row.off', h('span.fx-ic', icon('block')), h('div.fx-text', h('div.fx-title', d.name)), on));
      }
    }
    swap(list, parts);
  }

  scan();
}
