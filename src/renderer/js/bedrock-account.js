// Bedrock signs in with the Xbox app's account, not the launcher's: these
// tell when the two differ and open the Xbox app to change it.
import { t } from './i18n.js';
import { api } from './core.js';
import { toast } from './ui.js';

// null when they match or one side is unknown; else who Bedrock is and
// who the launcher wants.
export function bedrockMismatch(info, cfg) {
  if (!info || !info.installed || !info.signedIn || !cfg) return null;
  const acc = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount);
  if (!acc || !acc.xuid || acc.xuid === info.signedIn) return null;
  const other = (cfg.accounts || []).find((a) => a.xuid === info.signedIn);
  return { name: acc.name, who: other ? other.name : '' };
}

export function mismatchText(m) {
  return t('bedrock.otherAccount', { who: m.who ? ` (${m.who})` : '', name: m.name });
}

export async function switchBedrockAccount(name) {
  const ok = await api('bedrock:switchAccount').catch(() => false);
  toast(ok ? t('bedrock.switchHint', { name }) : t('bedrock.noXboxApp'), { kind: ok ? 'info' : 'warn', timeout: 14000 });
}
