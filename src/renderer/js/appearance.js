import { api, store, remote } from './core.js';
import { STEVE } from './skin3d.js';

export function appearanceKey() {
  const cfg = store.get('config') || {};
  const acc = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount) || (cfg.accounts || [])[0];
  const entry = (store.get('installs') || []).find((e) => e.id === cfg.selectedInstall);
  const edition = (entry && entry.isBedrock) || (acc && acc.type === 'xbox') ? 'bedrock' : 'java';
  return JSON.stringify([acc && acc.id, acc && acc.uuid, acc && acc.needsLogin, edition, cfg.bedrockSkin, acc && acc.skin, acc && acc.cape]);
}

export async function currentAppearance(account) {
  const key = JSON.parse(appearanceKey());
  const profile = await api('skins:appearance', { accountId: account ? account.id : key[0], edition: account ? (account.type === 'xbox' ? 'bedrock' : 'java') : key[3] }).catch(() => null);
  const url = (v) => /^https?:/i.test(v || '') ? remote(v) : v || '';
  return { url: url(profile && profile.skinUrl) || STEVE, model: profile && profile.model || 'classic', cape: url(profile && profile.capeUrl) };
}
