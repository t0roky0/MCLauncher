import { icon } from './icons.js';
import { t } from './i18n.js';

// One state mapping for the toolbar, member list and all five nameplates.
export function memberVoice(member, call) {
  const v = member.self ? (call.on ? {on:true, mic:!call.micOff, deaf:call.deaf} : null) : member.voice;
  if (!v?.on) return 'idle';
  if (v.deaf) return 'deaf';
  if (!v.mic) return 'muted';
  const talking = member.self ? call.speaking : call.peers.find(p => p.id === member.id)?.speaking;
  return talking ? 'speaking' : 'idle';
}
export function paintVoice(el, state) {
  if (!el || el.dataset.voice === state) return;
  el.dataset.voice = state;
  el.replaceChildren(icon(state === 'deaf' ? 'headsetOff' : state === 'muted' ? 'micOff' : 'mic'));
  el.setAttribute('aria-label', t('voice.indicator.' + state));
  el.title = t('voice.indicator.' + state);
}
