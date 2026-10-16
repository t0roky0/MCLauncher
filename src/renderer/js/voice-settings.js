// Voice settings, split by what each part is for: the microphone, how your
// voice goes out, what you hear, voice inside the game, the lobby's voice
// and the in-game overlay. Quick mic/sound switches stay on top of every tab.
// Used in the dialog (party panel's gear) and on the Settings page.
import { h, swap } from './dom.js';
import { icon } from './icons.js';
import { api, store } from './core.js';
import { button, toast, slider, dropdown, segmented, field, toggleRow, modal } from './ui.js';
import * as voice from './voice.js';

const ru = () => (store.get('config') || {}).language !== 'en';
const L = (r, e) => (ru() ? r : e);
const vcfg = () => ({ ...((store.get('config') || {}).voice || {}) });
const ocfg = () => ({ enabled: true, voice: 'always', corner: 'tl', size: 'm', notifications: true, ...((store.get('config') || {}).overlay || {}) });

async function saveVoice(patch) {
  store.set({ config: await api('config:set', { voice: { ...vcfg(), ...patch } }) });
}
async function saveOverlay(patch) {
  store.set({ config: await api('config:set', { overlay: { ...ocfg(), ...patch } }) });
}

const TABS = (kind) => kind === 'overlay' ? [
  { id: 'overlay', icon: 'image', label: L('Оверлей', 'Overlay'), hint: L('Вид и расположение', 'Look and layout') },
  { id: 'news', icon: 'bell', label: L('Уведомления', 'Notifications'), hint: L('Поверх игры', 'Over the game') },
  { id: 'video', icon: 'play', label: L('Запись видео', 'Recording'), hint: L('Кадры, качество, звук', 'Frames, quality, sound') },
  { id: 'replay', icon: 'refresh', label: L('Повтор', 'Instant replay'), hint: L('Последние секунды', 'The last seconds') },
  { id: 'keys', icon: 'gamepad', label: L('Клавиши', 'Keys'), hint: L('Меню, скрин, запись', 'Menu, shots, video') },
] : [
  { id: 'mic', icon: 'mic', label: L('Микрофон', 'Microphone'), hint: L('Устройство и проверка', 'Device and test') },
  { id: 'send', icon: 'signal', label: L('Передача', 'Talking'), hint: L('Когда вас слышно', 'When you are heard') },
  { id: 'hear', icon: 'headset', label: L('Звук', 'Sound'), hint: L('Наушники и колонки', 'Headphones, speakers') },
  { id: 'game', icon: 'gamepad', label: L('Голос в игре', 'In-game voice'), hint: L('Игроки рядом', 'Players nearby') },
  { id: 'lobby', icon: 'friends', label: L('Голос лобби', 'Lobby voice'), hint: L('Все в лобби', 'Everyone in the lobby') },
];

// A level meter 0..60 with the voice threshold mark.
function meter() {
  const el = h('div.pp-meter.big', h('div.pp-meter-fill'), h('div.pp-meter-mark'));
  el.paint = (level, open, threshold, showMark = true) => {
    el.firstChild.style.width = `${Math.min(100, (level / 60) * 100)}%`;
    el.classList.toggle('open', !!open);
    el.lastChild.style.left = `${(threshold / 60) * 100}%`;
    el.lastChild.hidden = !showMark;
  };
  return el;
}

// The microphone check when voice isn't on: the same device and
// processing switches, only measured here and never sent anywhere.
function micTest() {
  let stream = null, ctx = null, an = null;
  const buf = new Float32Array(512);
  return {
    async start(deviceId) {
      this.stop();
      const base = { echoCancellation: true, noiseSuppression: vcfg().noise !== 'off', autoGainControl: true, channelCount: 1 };
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base }).catch(() => navigator.mediaDevices.getUserMedia({ audio: base }));
      ctx = new AudioContext();
      an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
    },
    level() {
      if (!an) return 0;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
      return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    },
    running: () => !!an,
    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      stream = ctx = an = null;
    },
  };
}

// The next key or mouse button pressed; Esc cancels, Backspace clears.
function captureKey(onDone) {
  const done = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', done, true);
    window.removeEventListener('mousedown', done, true);
    if (e.type === 'keydown' && e.key === 'Escape') return onDone(null);
    if (e.type === 'keydown' && e.key === 'Backspace') return onDone({ vks: [], name: '' });
    const vk = voice.vkOf(e);
    if (!vk || (e.type === 'mousedown' && e.button === 0)) return onDone(null);
    const name = e.type === 'mousedown' ? ({ 1: L('Колесо мыши', 'Mouse wheel'), 3: L('Мышь 4', 'Mouse 4'), 4: L('Мышь 5', 'Mouse 5') }[e.button] || `Mouse ${e.button}`) : e.key.length === 1 ? e.key.toUpperCase() : e.code.replace(/^Key|^Digit/, '');
    onDone({ vks: [vk], name });
  };
  setTimeout(() => {
    window.addEventListener('keydown', done, true);
    window.addEventListener('mousedown', done, true);
  }, 0);
  return () => {
    window.removeEventListener('keydown', done, true);
    window.removeEventListener('mousedown', done, true);
  };
}

function nearbyStatus() {
  const n = voice.nearbyVoiceState();
  if (!n.nearbyReady) {
    const b = n.bedrockBridge;
    if (b?.status === 'loading') return { kind: 'wait', text: L('Bedrock: подключаем модуль голоса…', 'Bedrock: connecting the voice module…') };
    if (b?.status === 'unsupported') return { kind: 'bad', text: L('Эта сборка Bedrock пока не поддерживается модулем голоса.', 'This Bedrock build is not supported by the voice module yet.') };
    if (b?.status === 'error') return { kind: 'bad', text: L(`Bedrock: модуль голоса не подключён. ${b.reason || ''}`, `Bedrock: voice module not connected. ${b.reason || ''}`) };
    return { kind: 'idle', text: L('Сейчас вы не в мире. Голос включится сам, как только зайдёте в мир Java или Bedrock.', 'You are not in a world. Voice starts by itself once you enter a Java or Bedrock world.') };
  }
  if (!n.on) return { kind: 'wait', text: L('Вы в мире — включаем голос…', 'In a world — starting voice…') };
  const c = n.peers.filter((p) => p.state === 'connected').length;
  if (!c) return { kind: 'ok', text: L('Голос включён. Рядом пока нет игроков с MC Launcher.', 'Voice is on. No MC Launcher players nearby yet.') };
  return { kind: 'ok', text: L(`Голос включён: слышно игроков рядом — ${c}.`, `Voice is on: ${c} nearby.`) };
}

export function voiceSettingsView({ kind = 'voice', tab = kind === 'overlay' ? 'overlay' : 'mic' } = {}) {
  const el = h('div.vs');
  const nav = h('div.vs-nav');
  const top = h('div.vs-top');
  const pane = h('div.vs-pane');
  el.append(nav, h('div.vs-main', top, pane));
  const test = micTest();
  let current = tab;
  let devs = { inputs: [], outputs: [] };
  let stopCapture = null;
  let capturing = '';
  let live = null; // { meter, threshold } on the tabs that show the level
  const cleanup = []; // the current tab's own listeners
  const statusLine = h('div.vs-status');

  voice.devices().then((d) => { devs = d; render(); }).catch(() => {});

  function renderNav() {
    swap(nav, TABS(kind).map((tb) => {
      const b = h('button.vs-tab', { type: 'button', class: tb.id === current ? 'active' : '' }, icon(tb.icon), h('span.vs-tab-text', h('span.vs-tab-label', tb.label), h('span.vs-tab-hint', tb.hint)));
      b.addEventListener('click', () => {
        if (current === tb.id) return;
        current = tb.id;
        if (current !== 'mic' && current !== 'send') test.stop();
        render();
      });
      return b;
    }));
  }

  // Quick switches above every tab.
  function renderTop() {
    top.hidden = kind !== 'voice';
    if (kind !== 'voice') return;
    const v = vcfg();
    const chip = (on, iconOn, iconOff, labelOn, labelOff, onClick) => {
      const b = h(`button.vs-chip${on ? '' : '.off'}`, { type: 'button' }, icon(on ? iconOn : iconOff), h('span', on ? labelOn : labelOff));
      b.addEventListener('click', onClick);
      return b;
    };
    swap(top,
      chip(!v.micOff, 'mic', 'micOff', L('Микрофон включён', 'Mic on'), L('Микрофон выключен', 'Mic off'), async () => { await voice.setMicOff(!v.micOff); renderTop(); }),
      chip(!v.deaf, 'headset', 'headsetOff', L('Звук включён', 'Sound on'), L('Звук выключен', 'Sound off'), async () => { await voice.setDeaf(!v.deaf); renderTop(); }),
      v.muteKey?.length ? h('span.vs-top-hint', L(`В игре: ${v.muteName}`, `In game: ${v.muteName}`)) : null);
  }

  const section = (title, ...content) => h('div.vs-section', title ? h('div.vs-section-title', title) : null, ...content);

  function micTab() {
    const v = vcfg();
    const inputs = [{ value: '', label: L('Как в Windows', 'Windows default') }, ...devs.inputs.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `${L('Микрофон', 'Microphone')} ${i + 1}` }))];
    const m = meter();
    live = { meter: m, threshold: v.threshold ?? 18, mark: v.mode === 'vad' };
    const testBtn = button(test.running() ? L('Остановить проверку', 'Stop the test') : L('Проверить микрофон', 'Test the microphone'), {
      icon: 'mic', cls: 'btn-sm',
      onClick: async () => {
        if (test.running()) test.stop();
        else await test.start(vcfg().input).catch((e) => toast(e.name === 'NotAllowedError' ? L('Нет доступа к микрофону — проверьте «Параметры Windows → Конфиденциальность → Микрофон».', 'No microphone access — check Windows privacy settings.') : e.message, { kind: 'error' }));
        render();
      },
    });
    const inVoice = voice.settingsState().on;
    return [
      section(L('Устройство', 'Device'),
        field(null, dropdown(inputs, v.input || '', async (id) => {
          await voice.setInput(id).catch((e) => toast(e.message, { kind: 'error' }));
          if (test.running()) await test.start(id).catch(() => {});
        }))),
      section(L('Проверка', 'Check'),
        m,
        h('div.row.vs-row', inVoice ? h('div.hint.grow', L('Вы в голосовом — полоска показывает ваш голос прямо сейчас.', 'You are in voice — the bar shows your voice right now.')) : h('div.hint.grow', L('Скажите что-нибудь: полоска должна двигаться. Звук никуда не отправляется.', 'Say something: the bar should move. Nothing is sent anywhere.')), inVoice ? null : testBtn)),
      section(L('Шумоподавление', 'Noise suppression'),
        segmented([
          { value: 'rnnoise', label: L('Нейросеть', 'Neural') },
          { value: 'standard', label: L('Обычное', 'Standard') },
          { value: 'off', label: L('Выкл.', 'Off') },
        ], v.noise || 'rnnoise', (noise) => voice.setNoise(noise).catch((e) => toast(e.message, { kind: 'error' }))),
        h('div.hint', L('Нейросеть (RNNoise) лучше убирает клавиатуру и вентилятор. Обработка идёт на вашем компьютере.', 'Neural (RNNoise) removes keyboard and fan noise best. It runs on your computer.'))),
    ];
  }

  function sendTab() {
    const v = vcfg();
    const modes = segmented([
      { value: 'vad', label: L('Голосом', 'By voice'), icon: 'mic' },
      { value: 'ptt', label: L('По кнопке', 'Push to talk'), icon: 'gamepad' },
      { value: 'open', label: L('Всегда', 'Always'), icon: 'signal' },
    ], v.mode || 'vad', async (mode) => { await voice.setMode(mode); render(); });
    const modeHint = { vad: L('Микрофон включается сам, когда вы говорите громче отметки.', 'The mic opens by itself when you speak above the mark.'), ptt: L('Вас слышно, только пока зажата клавиша — работает и в игре.', 'You are heard only while the key is held — in game too.'), open: L('Вас слышно всё время, пока вы в голосовом.', 'You are heard all the time while in voice.') }[v.mode || 'vad'];
    const keyButton = (which, value, name) => {
      const waiting = capturing === which;
      return button(waiting ? L('Нажмите клавишу…', 'Press a key…') : name || L('Не назначена', 'Not set'), {
        cls: `pp-key vs-key${waiting ? ' waiting' : ''}`,
        onClick: () => {
          stopCapture?.();
          capturing = which;
          render();
          stopCapture = captureKey(async (k) => {
            capturing = '';
            stopCapture = null;
            if (k) {
              if (which === 'ptt') { if (k.vks.length) await voice.setPttKey(k.vks, k.name); }
              else await saveVoice({ muteKey: k.vks, muteName: k.name });
            }
            render();
          });
        },
      });
    };
    let detail;
    if ((v.mode || 'vad') === 'vad') {
      const m = meter();
      live = { meter: m, threshold: v.threshold ?? 18, mark: true };
      const th = slider({ min: 0, max: 60, step: 1, value: v.threshold ?? 18, format: (n) => String(n), onInput: (n) => { live.threshold = n; }, onChange: (n) => voice.setThreshold(n) });
      detail = section(L('Чувствительность', 'Sensitivity'), m, th,
        h('div.hint', voice.settingsState().on || test.running() ? L('Говорите: микрофон открывается, когда полоса заходит за белую отметку.', 'Speak: the mic opens when the bar passes the white mark.') : L('Чтобы видеть уровень, включите проверку на вкладке «Микрофон» или войдите в голосовой.', 'To see the level, start the test on the Microphone tab or join voice.')));
    } else if (v.mode === 'ptt') {
      detail = section(L('Клавиша рации', 'Push-to-talk key'), h('div.row', keyButton('ptt', v.ptt, v.pttName)),
        h('div.hint', voice.settingsState().pttNative ? L('Работает поверх игры. Можно назначить боковую кнопку мыши.', 'Works over the game. A mouse side button works too.') : L('Без модуля C++ клавиша работает, только пока окно лаунчера активно.', 'Without the C++ module the key only works while the launcher is focused.')));
    }
    return [
      section(L('Когда вас слышно', 'When you are heard'), modes, h('div.hint', modeHint)),
      detail,
      section(L('Микрофон вкл/выкл в игре', 'Mic on/off in game'),
        h('div.row.vs-row', keyButton('mute', v.muteKey, v.muteName), v.muteKey?.length ? button(L('Убрать', 'Clear'), { cls: 'btn-sm', variant: 'ghost', onClick: async () => { await saveVoice({ muteKey: [], muteName: '' }); render(); } }) : null),
        h('div.hint', L('Одно нажатие выключает микрофон, следующее — включает. Оверлей покажет, что изменилось. Backspace при выборе — убрать.', 'One press turns the mic off, the next turns it on; the overlay shows it. Backspace while picking clears it.'))),
    ];
  }

  function hearTab() {
    const v = vcfg();
    const outputs = [{ value: '', label: L('Как в Windows', 'Windows default') }, ...devs.outputs.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `${L('Вывод', 'Output')} ${i + 1}` }))];
    return [
      section(L('Куда идёт звук', 'Sound goes to'), field(null, dropdown(outputs, v.output || '', (id) => voice.setOutput(id)))),
      section(L('Полный мут', 'Deafen'),
        toggleRow(L('Никого не слышно, и вас тоже', 'Hear no one, and no one hears you'), L('Быстрый переключатель — также сверху и в окне лобби.', 'Also at the top and in the lobby window.'), !!v.deaf, async (on) => { await voice.setDeaf(on); renderTop(); })),
      section(null, h('div.hint', L('Громкость каждого друга — в окне лобби, ползунок у его имени.', 'Each friend’s volume is in the lobby window, next to their name.'))),
    ];
  }

  function gameTab() {
    const v = vcfg();
    return [
      section(L('Как это работает', 'How it works'),
        h('div.hint.vs-explain', L('Включается сам, когда вы заходите в мир Java или Bedrock. Слышно только игроков с MC Launcher рядом с вами: чем дальше — тем тише, за радиусом — тишина. Ничего нажимать не нужно.', 'Starts by itself when you enter a Java or Bedrock world. You hear only MC Launcher players near you: further is quieter, beyond the range is silence. Nothing to press.')),
        statusLine),
      section(L('Объёмный звук', '3D sound'),
        h('div.hint.vs-explain', L('Java: голос слышно с той стороны, где стоит игрок (в наушниках — и спереди/сзади, сверху/снизу). Стены между вами приглушают его, под водой он глухой, в пещере и доме появляется эхо.', 'Java: a voice comes from where the player stands (with headphones also front/back, up/down). Walls between you muffle it, underwater it’s dull, caves and houses add echo.')),
        h('div.hint', L('Bedrock: пока только громкость по расстоянию — направление появится, когда модуль научится читать поворот камеры в вашей версии игры.', 'Bedrock: distance volume for now — direction comes once the module reads the camera turn in your game version.'))),
      section(L('Радиус слышимости', 'Hearing range'),
        segmented([16, 32, 64].map((n) => ({ value: String(n), label: L(`${n} блоков`, `${n} blocks`) })), String(v.range || 32), (n) => voice.setRange(Number(n)))),
      section('Bedrock', h('div.hint', L('В Bedrock F8 открывает панель MC Launcher в игре, F11 в ней — микрофон. Модуль должен поддерживать вашу версию игры.', 'In Bedrock, F8 opens the MC Launcher panel in game; F11 there toggles the mic. The module must support your game version.'))),
    ];
  }

  function lobbyTab() {
    const p = store.get('party') || {};
    const s = voice.voiceState();
    const action = !p.active
      ? h('div.hint', L('Сначала создайте лобби или войдите в него — тогда здесь появится кнопка.', 'Create or join a lobby first — the button appears here then.'))
      : s.on
        ? button(L('Выйти из голосового лобби', 'Leave lobby voice'), { icon: 'hangup', onClick: () => { voice.leave(); render(); } })
        : button(s.joining ? L('Подключаем…', 'Connecting…') : L('Войти в голосовой лобби', 'Join lobby voice'), { icon: 'mic', variant: 'primary', disabled: s.joining, onClick: () => voice.join().then(render).catch((e) => toast(e.message, { kind: 'error' })) });
    return [
      section(L('Как это работает', 'How it works'),
        h('div.hint.vs-explain', L('Общий канал со всеми в лобби — слышно всех, где бы они ни были: в меню, в другом мире или на сервере. Входите кнопкой; связь продолжается и в игре.', 'One channel with everyone in the lobby, wherever they are: menu, another world or a server. Join with the button; it keeps going in game.'))),
      section(L('Голосовой лобби', 'Lobby voice'), h('div.row.vs-row', action)),
      section(null, h('div.hint', L('Если вы одновременно в лобби и в мире с друзьями, в игре слышно и тех, кто рядом, и лобби.', 'In a lobby and a world at once, you hear both the lobby and players nearby.'))),
    ];
  }

  // The overlay: a live preview of the real overlay page in a frame (drag the
  // parts right there), and what it shows.
  function overlayTab() {
    const o = ocfg();
    const frame = h('iframe.vs-ov-frame', { src: 'mcl://app/overlay.html', tabindex: '-1', title: 'overlay' });
    const stage = h('div.vs-ov-stage', frame);
    const post = () => {
      const c = ocfg();
      frame.contentWindow?.postMessage({ source: 'mcl-settings', state: {
        ru: ru(), size: c.size, opacity: c.opacity, faces: c.faces, self: c.self, notifications: c.notifications,
        voiceMode: c.voice, layout: c.layout, editing: true, editName: c.editName, voice: null, toasts: [],
      } }, location.origin);
    };
    const onMessage = (e) => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow || e.data?.source !== 'mcl-overlay') return;
      if (e.data.type === 'ready') post();
      else if (e.data.type === 'save' && e.data.payload?.layout) saveOverlay({ layout: { ...ocfg().layout, ...e.data.payload.layout } }).then(post);
    };
    window.addEventListener('message', onMessage);
    // the screen's shape (where the game usually is), small enough to read
    const W = 1024, H = Math.round(W * Math.max(0.4, Math.min(0.8, window.screen.height / window.screen.width)));
    Object.assign(frame.style, { width: `${W}px`, height: `${H}px` });
    const fit = new ResizeObserver(() => requestAnimationFrame(() => {
      const k = stage.clientWidth / W;
      frame.style.transform = `scale(${k})`;
      stage.style.height = `${Math.round(H * k)}px`;
    }));
    fit.observe(stage);
    cleanup.push(() => { window.removeEventListener('message', onMessage); fit.disconnect(); });
    const set = (patch) => saveOverlay(patch).then(post);
    // a key over the game: the menu, a screenshot, recording on/off
    const keyBtn = (which) => {
      const waiting = capturing === which;
      const name = o[`${which}Name`];
      return button(waiting ? L('Нажмите клавишу…', 'Press a key…') : name || L('Не назначена', 'Not set'), {
        cls: `pp-key vs-key${waiting ? ' waiting' : ''}`,
        onClick: () => {
          stopCapture?.();
          capturing = which;
          render();
          stopCapture = captureKey(async (k) => {
            capturing = '';
            stopCapture = null;
            if (k) await saveOverlay({ [`${which}Key`]: k.vks, [`${which}Name`]: k.name });
            render();
          });
        },
      });
    };
    if (!o.enabled) {
      return [
        section(null, toggleRow(L('Оверлей в игре', 'In-game overlay'), L('Поверх Minecraft: кто в голосовом и кто говорит, ваш микрофон, уведомления лаунчера.', 'Over Minecraft: who is in voice and talking, your mic, launcher news.'), false, async (on) => { await saveOverlay({ enabled: on }); render(); })),
      ];
    }
    return [
      section(null, toggleRow(L('Оверлей в игре', 'In-game overlay'), L('Поверх Minecraft: кто в голосовом и кто говорит, ваш микрофон, уведомления лаунчера.', 'Over Minecraft: who is in voice and talking, your mic, launcher news.'), true, async (on) => { await saveOverlay({ enabled: on }); render(); })),
      section(L('Расположение', 'Layout'), stage,
        h('div.row.vs-row', h('div.hint.grow', L('Перетащите панели мышью — так они встанут в игре. В игре то же самое — «Расположение» в меню оверлея.', 'Drag the panels — that’s where they’ll be in the game. In the game: Layout in the overlay menu.')),
          button(L('Сбросить', 'Reset'), { cls: 'btn-sm', variant: 'ghost', onClick: () => set({ layout: undefined }) }))),
      section(L('Вид', 'Look'),
        h('div.vs-grid',
          h('span.vs-grid-label', L('Размер', 'Size')),
          segmented([
            { value: 's', label: L('Компактный', 'Compact') },
            { value: 'm', label: L('Обычный', 'Normal') },
            { value: 'l', label: L('Крупный', 'Large') },
            { value: 'xl', label: L('Огромный', 'Huge') },
          ], o.size, (x) => set({ size: x })),
          h('span.vs-grid-label', L('Фон', 'Background')),
          slider({ min: 0, max: 100, step: 5, value: o.opacity, format: (n) => `${n}%`, onChange: (n) => set({ opacity: n }) }),
          h('span.vs-grid-label', L('Голосовой чат', 'Voice chat')),
          segmented([
            { value: 'always', label: L('Все', 'Everyone') },
            { value: 'speaking', label: L('Кто говорит', 'Who talks') },
            { value: 'off', label: L('Скрыть', 'Hide') },
          ], o.voice, (x) => set({ voice: x }))),
        toggleRow(L('Лица из скинов', 'Faces from skins'), L('Иначе — первая буква имени.', 'Otherwise the name’s first letter.'), o.faces, (on) => set({ faces: on })),
        toggleRow(L('Показывать себя', 'Show yourself'), L('Выключенный микрофон виден всегда.', 'A muted mic always shows.'), o.self, (on) => set({ self: on }))),
    ];
  }

  // ---- the overlay's other tabs ----
  const oset = (patch) => saveOverlay(patch).then(() => render());
  const keyBtn = (which) => {
    const o = ocfg();
    const waiting = capturing === which;
    const name = o[`${which}Name`];
    return button(waiting ? L('Нажмите клавишу…', 'Press a key…') : name || L('Не назначена', 'Not set'), {
      cls: `pp-key vs-key${waiting ? ' waiting' : ''}`,
      onClick: () => {
        stopCapture?.();
        capturing = which;
        render();
        stopCapture = captureKey(async (k) => {
          capturing = '';
          stopCapture = null;
          if (k) await saveOverlay({ [`${which}Key`]: k.vks, [`${which}Name`]: k.name });
          render();
        });
      },
    });
  };

  function newsTab() {
    const o = ocfg();
    return [
      section(null,
        toggleRow(L('Уведомления в игре', 'News in game'), L('Друзья в сети, приглашения, сообщения, кто зашёл в лобби — поверх игры вместо уведомлений Windows.', 'Friends online, invites, messages, who joined the lobby — over the game instead of Windows pop-ups.'), o.notifications, (on) => oset({ notifications: on }))),
      o.notifications ? section(L('Сколько держать', 'Keep for'),
        segmented([3, 6, 10].map((n) => ({ value: String(n), label: L(`${n} секунд`, `${n} seconds`) })), String(o.toastSeconds), (n) => oset({ toastSeconds: Number(n) }))) : null,
    ];
  }

  function videoTab() {
    const o = ocfg();
    return [
      section(L('Частота кадров', 'Frame rate'),
        segmented([{ value: '60', label: L('60 кадров/с', '60 fps') }, { value: '30', label: L('30 кадров/с', '30 fps') }], String(o.fps), (x) => oset({ fps: Number(x) })),
        h('div.hint', L('Кадры снимает и сжимает видеокарта (как NVIDIA ShadowPlay) — на FPS в игре почти не влияет.', 'The graphics card captures and encodes (like NVIDIA ShadowPlay) — it barely touches in-game FPS.'))),
      section(L('Качество', 'Quality'),
        segmented([
          { value: 'normal', label: L('Обычное', 'Normal') },
          { value: 'high', label: L('Высокое', 'High') },
          { value: 'max', label: L('Максимальное', 'Maximum') },
        ], o.quality, (x) => oset({ quality: x })),
        h('div.hint', { normal: L('8 Мбит/с — минута видео ≈ 60 МБ.', '8 Mbit/s — a minute is about 60 MB.'), high: L('16 Мбит/с — минута видео ≈ 120 МБ.', '16 Mbit/s — a minute is about 120 MB.'), max: L('30 Мбит/с — минута видео ≈ 225 МБ.', '30 Mbit/s — a minute is about 225 MB.') }[o.quality])),
      section(L('Что попадает в видео', 'What goes into videos'),
        toggleRow(L('Звук игры и голоса друзей', 'Game sound and friends voices'), L('Всё, что слышно на компьютере.', 'Everything the computer plays.'), o.recordAudio, (on) => oset({ recordAudio: on })),
        toggleRow(L('Мой голос', 'My voice'), L('Только когда вас слышно в голосовом чате: не в муте, с рацией — пока зажата клавиша.', 'Only while you are heard in voice chat: not muted, with push-to-talk while the key is held.'), o.recordMic, (on) => oset({ recordMic: on })),
        toggleRow(L('Оверлей', 'Overlay'), L('Голосовой чат и уведомления на видео. Меню оверлея не попадает никогда.', 'The voice panel and news in videos. The overlay menu never is.'), o.recordOverlay, (on) => oset({ recordOverlay: on }))),
      section(null, h('div.row.vs-row',
        button(L('Папка видео', 'Videos folder'), { icon: 'folder', cls: 'btn-sm', onClick: () => api('app:openFolder', 'videos') }),
        button(L('Папка скриншотов', 'Screenshots folder'), { icon: 'folder', cls: 'btn-sm', onClick: () => api('app:openFolder', 'pictures') }))),
    ];
  }

  function replayTab() {
    const o = ocfg();
    const lengths = [[60, L('1 мин', '1 min')], [120, L('2 мин', '2 min')], [300, L('5 мин', '5 min')], [600, L('10 мин', '10 min')], [1800, L('30 мин', '30 min')]];
    return [
      section(null,
        toggleRow(L('Повтор', 'Instant replay'), L('Пока вы играете, лаунчер держит последние секунды игры. Случилось что-то крутое — нажмите клавишу, и этот момент сохранится видео.', 'While you play, the launcher keeps the last seconds. Something great happened: press the key and that moment is saved as a video.'), o.replay, (on) => oset({ replay: on }))),
      o.replay ? section(L('Сколько держать', 'How much to keep'),
        segmented(lengths.map(([n, label]) => ({ value: String(n), label })), String(o.replaySeconds), (n) => oset({ replaySeconds: Number(n) })),
        h('div.hint', L(`Частота кадров, качество и звук — как на вкладке «Запись видео». Повтор хранится во временных файлах: на диске ≈ ${Math.round(((o.replaySeconds + 60) / 60) * ({ normal: 60, high: 120, max: 225 }[o.quality] || 120))} МБ.`, `Frame rate, quality and sound as on the Recording tab. The replay lives in temporary files: about ${Math.round(((o.replaySeconds + 60) / 60) * ({ normal: 60, high: 120, max: 225 }[o.quality] || 120))} MB on disk.`))) : null,
      o.replay ? section(L('Сохранить повтор', 'Save the replay'), h('div.row.vs-row', keyBtn('replay')),
        h('div.hint', L('Ещё — кнопка «Сохранить повтор» в меню оверлея (вкладка «Захват»).', 'Also: Save replay in the overlay menu (Capture tab).'))) : null,
    ];
  }

  function keysTab() {
    return [
      section(null,
        h('div.vs-grid',
          h('span.vs-grid-label', L('Меню оверлея', 'Overlay menu')), h('div.row', keyBtn('edit')),
          h('span.vs-grid-label', L('Скриншот', 'Screenshot')), h('div.row', keyBtn('shot')),
          h('span.vs-grid-label', L('Запись: начать / стоп', 'Recording: start / stop')), h('div.row', keyBtn('rec')),
          h('span.vs-grid-label', L('Сохранить повтор', 'Save the replay')), h('div.row', keyBtn('replay'))),
        h('div.hint', L('Меню поверх игры, как Game Bar: голос и громкость каждого, чат лобби, скриншоты, запись и повтор, расположение панелей. Backspace при выборе — убрать клавишу.', 'A menu over the game, like Game Bar: voice and everyone’s volume, lobby chat, screenshots, recording and replay, panel layout. Backspace while picking clears a key.')),
        h('div.hint', L('Оверлей виден в оконном режиме и на весь экран без рамки (Bedrock — всегда). Если в Java на весь экран (F11) его не видно — выключите полноэкранный режим.', 'The overlay shows windowed and borderless (Bedrock always). If Java fullscreen (F11) hides it, turn fullscreen off.'))),
    ];
  }

  function render() {
    live = null;
    for (const fn of cleanup.splice(0)) fn();
    renderNav();
    renderTop();
    const build = { mic: micTab, send: sendTab, hear: hearTab, game: gameTab, lobby: lobbyTab, overlay: overlayTab, news: newsTab, video: videoTab, replay: replayTab, keys: keysTab }[current] || (kind === 'overlay' ? overlayTab : micTab);
    swap(pane, build());
    paintLive();
  }

  function paintLive() {
    const s = voice.settingsState();
    if (live) {
      const level = s.on ? s.level : test.level();
      live.meter.paint(level, s.on ? s.open : level >= live.threshold, live.threshold, live.mark !== false);
    }
    const st = nearbyStatus();
    statusLine.className = `vs-status ${st.kind}`;
    statusLine.textContent = st.text;
  }

  const timer = setInterval(paintLive, 60);
  const offs = [store.on('party', () => { if (current === 'lobby') render(); })];
  render();
  return {
    el,
    dispose() {
      clearInterval(timer);
      for (const fn of cleanup.splice(0)) fn();
      test.stop();
      stopCapture?.();
      offs.forEach((off) => off());
    },
  };
}

export const overlaySettingsView = (opts = {}) => voiceSettingsView({ ...opts, kind: 'overlay' });

export function openVoiceSettings(tab) {
  const view = voiceSettingsView({ tab });
  modal({ title: L('Голосовой чат', 'Voice chat'), body: view.el, width: 720, cls: 'vs-dialog', onClose: () => view.dispose() });
}
