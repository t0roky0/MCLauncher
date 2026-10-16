'use strict';
// Microsoft sign-in and every token derived from it.
//
//   Microsoft (OAuth code + PKCE, refresh token kept)
//     └─ Xbox Live user token            (user.auth.xboxlive.com, ~14 days)
//          ├─ XSTS for Minecraft         → Minecraft access token (24 h)
//          └─ XSTS for xboxlive.com      → friends / presence (Friends tab)
//
// v1 kept only the 24-hour Minecraft token, which is why it "forgot" the
// account every day. Here the Microsoft refresh token is stored (encrypted,
// see config.setSecrets) and everything below it is re-derived on demand,
// so a sign-in lasts until the person signs out or Microsoft revokes it.
//
// The sign-in page opens inside the launcher (its own window, its own
// cookie partition — in memory only, wiped after every sign-in, so no
// Microsoft session ever sits on disk) or in the system browser; either way
// it ends at a loopback http://localhost:<port> redirect, which the Azure app
// registration allows for any port.

const http = require('http');
const crypto = require('crypto');
const { BrowserWindow, shell, session } = require('electron');
const net = require('./net');
const config = require('./config');
const log = require('./log');

const AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const SCOPE = 'XboxLive.signin offline_access';
const RP_MINECRAFT = 'rp://api.minecraftservices.com/';
const RP_XBOX = 'http://xboxlive.com';
const AUTH_PARTITION = 'msauth'; // no "persist:" — never written to disk
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code || 'auth';
  }
}

let pending = null;
const locks = new Map();

const clientId = () => config.get().msClientId || config.DEFAULT_CLIENT_ID;

function pkcePair() {
  const verifier = crypto.randomBytes(64).toString('base64url').slice(0, 128);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function resultPage(ok) {
  const text = ok
    ? 'Вход выполнен — эту вкладку можно закрыть. / Signed in — you can close this tab.'
    : 'Вход отменён или не удался. / Sign-in was cancelled or failed.';
  return `<!doctype html><meta charset="utf-8"><title>MC Launcher</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#151414;color:#eee;font:16px 'Segoe UI',sans-serif">
<div style="text-align:center"><div style="font-size:42px">${ok ? '✔' : '✖'}</div><p>${text}</p></div></body>`;
}

function startLoopback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---- Xbox / Minecraft token exchange -------------------------------------

function xstsMessage(body) {
  let code = '';
  try {
    code = String(JSON.parse(body).XErr || '');
  } catch {
    code = (String(body).match(/2148916\d{3}/) || [''])[0];
  }
  const map = {
    2148916227: 'Этот аккаунт Xbox заблокирован.',
    2148916233: 'У этого аккаунта Microsoft нет профиля Xbox — создайте его на xbox.com и попробуйте снова.',
    2148916235: 'Xbox Live недоступен в стране этого аккаунта.',
    2148916236: 'Аккаунту нужна проверка возраста на xbox.com (Южная Корея).',
    2148916237: 'Аккаунту нужна проверка возраста на xbox.com (Южная Корея).',
    2148916238: 'Детский аккаунт: его нужно добавить в семейную группу Microsoft.',
  };
  return map[code] || `Xbox Live отклонил вход${code ? ` (код ${code})` : ''}.`;
}

async function msaTokenRequest(fields) {
  try {
    return await net.postForm(TOKEN_URL, { client_id: clientId(), scope: SCOPE, ...fields }, { retries: 2 });
  } catch (e) {
    if (e.status === 400 || e.status === 401) {
      let desc = '';
      try {
        const j = JSON.parse(e.body);
        desc = j.error === 'invalid_grant' ? 'invalid_grant' : j.error_description || j.error;
      } catch {
        /* keep generic */
      }
      if (desc === 'invalid_grant') throw new AuthError('Сессия Microsoft истекла — войдите снова.', 'expired');
      throw new AuthError(`Microsoft отклонил вход: ${desc || e.message}`);
    }
    throw e;
  }
}

async function xblAuthenticate(msaAccess) {
  const r = await net.postJson(
    XBL_AUTH_URL,
    {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccess}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    { headers: { 'x-xbl-contract-version': '1' }, retries: 2 },
  );
  return { token: r.Token, uhs: r.DisplayClaims.xui[0].uhs, exp: Date.parse(r.NotAfter) || Date.now() + 86400000 };
}

async function xstsAuthorize(xblToken, relyingParty) {
  let r;
  try {
    r = await net.postJson(
      XSTS_URL,
      { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: relyingParty, TokenType: 'JWT' },
      { headers: { 'x-xbl-contract-version': '1' }, retries: 2 },
    );
  } catch (e) {
    if (e.status === 401) throw new AuthError(xstsMessage(e.body), 'xsts');
    throw e;
  }
  const xui = (r.DisplayClaims && r.DisplayClaims.xui && r.DisplayClaims.xui[0]) || {};
  return {
    token: r.Token,
    uhs: xui.uhs,
    xuid: xui.xid || '',
    gamertag: xui.gtg || '',
    exp: Date.parse(r.NotAfter) || Date.now() + 3600000,
  };
}

async function minecraftLogin(xsts) {
  const r = await net.postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${xsts.uhs};${xsts.token}` }, { retries: 3 });
  return { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 86400) * 1000 };
}

async function minecraftProfile(mcToken) {
  try {
    return await net.getJson(MC_PROFILE_URL, { headers: { Authorization: `Bearer ${mcToken}` }, retries: 2 });
  } catch (e) {
    if (e.status === 404) {
      throw new AuthError('У аккаунта ещё нет профиля Minecraft — задайте ник на minecraft.net.', 'noprofile');
    }
    throw e;
  }
}

// Which editions the account has, from the store's entitlements. Game Pass
// counts as Java (the official launcher lets it play). If the endpoint is
// down the profile request decides alone, as before.
async function editions(mcToken) {
  try {
    const r = await net.getJson(MC_ENTITLEMENTS_URL, { headers: { Authorization: `Bearer ${mcToken}` }, retries: 1 });
    const names = (Array.isArray(r.items) ? r.items : []).map((i) => String((i && i.name) || ''));
    return {
      known: true,
      java: names.some((n) => /^(product|game)_minecraft$/.test(n) || /game_pass/.test(n)),
      bedrock: names.some((n) => /minecraft_bedrock/.test(n)),
    };
  } catch {
    return { known: false, java: true, bedrock: false };
  }
}

// A gamertag as a Java name: letters, digits, _; 3–16 long.
function javaName(gamertag) {
  let n = String(gamertag || '').replace(/#.*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (n.length > 16) n = n.slice(0, 16);
  if (n.length < 3) n = `${n}Player`.slice(0, Math.max(3, n.length + 6));
  return n;
}

// ---- interactive sign-in --------------------------------------------------

async function signInInteractive({ inApp = true, parent = null } = {}) {
  if (pending) pending.cancel(new AuthError('Вход перезапущен.', 'cancelled'));
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const { server, port } = await startLoopback();
  const redirectUri = `http://localhost:${port}`;
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  const authUrl = `${AUTHORIZE_URL}?${params}`;
  log.info(`Microsoft sign-in started (${inApp ? 'in-app window' : 'system browser'}).`);

  let win = null;
  const query = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, q) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* already closed */
      }
      pending = null;
      if (win && !win.isDestroyed()) {
        const w = win;
        win = null;
        setTimeout(() => !w.isDestroyed() && w.destroy(), 50);
      }
      // the launcher keeps its own (encrypted) refresh token; the web
      // session isn't needed past this point
      setTimeout(() => clearBrowserSession().catch(() => {}), 400);
      if (err) reject(err);
      else resolve(q);
    };
    const timer = setTimeout(() => finish(new AuthError('Время входа истекло — попробуйте ещё раз.', 'timeout')), SIGN_IN_TIMEOUT_MS);
    pending = { cancel: (e) => finish(e || new AuthError('Вход отменён.', 'cancelled')) };

    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const q = Object.fromEntries(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(!!q.code));
      finish(null, q);
    });

    if (!inApp) {
      shell.openExternal(authUrl);
      return;
    }
    win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent || undefined,
      show: false,
      title: 'Вход в Microsoft — MC Launcher',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: AUTH_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setMenu(null);
    const intercept = (e, url) => {
      if (typeof url === 'string' && url.startsWith(redirectUri)) {
        e.preventDefault();
        finish(null, Object.fromEntries(new URL(url).searchParams));
      }
    };
    win.webContents.on('will-redirect', intercept);
    win.webContents.on('will-navigate', intercept);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.once('ready-to-show', () => win && win.show());
    win.on('closed', () => {
      win = null;
      finish(new AuthError('Вход отменён.', 'cancelled'));
    });
    win.loadURL(authUrl).catch((e) => {
      // ERR_ABORTED is what an intercepted redirect looks like from here.
      if (!/ERR_ABORTED/.test(String(e.message))) finish(new AuthError(`Не удалось открыть страницу входа: ${e.message}`));
    });
  });

  if (query.error) {
    throw new AuthError(
      query.error === 'access_denied' ? 'Вход отменён.' : `Microsoft: ${query.error_description || query.error}`,
      query.error === 'access_denied' ? 'cancelled' : 'auth',
    );
  }
  if (!query.code) throw new AuthError('Microsoft не вернул код авторизации.');
  if (query.state !== state) throw new AuthError('Ответ входа не совпал с запросом — попробуйте ещё раз.');

  const tokens = await msaTokenRequest({
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return completeLogin(tokens);
}

function cancelSignIn() {
  if (pending) pending.cancel();
}

async function completeLogin(tokens) {
  const secrets = {
    msaAccess: tokens.access_token,
    msaRefresh: tokens.refresh_token,
    msaExp: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
  };
  const xbl = await xblAuthenticate(secrets.msaAccess);
  Object.assign(secrets, { xbl: xbl.token, xblExp: xbl.exp, uhs: xbl.uhs });

  const [mcXsts, xboxXsts] = await Promise.all([
    xstsAuthorize(xbl.token, RP_MINECRAFT),
    xstsAuthorize(xbl.token, RP_XBOX).catch((e) => {
      log.warn(`Xbox social token unavailable: ${e.message}`);
      return null;
    }),
  ]);
  const mc = await minecraftLogin(mcXsts);
  Object.assign(secrets, { mc: mc.token, mcExp: mc.exp });
  if (xboxXsts) Object.assign(secrets, { xsts: xboxXsts.token, xstsUhs: xboxXsts.uhs, xstsExp: xboxXsts.exp });

  const owned = await editions(mc.token);
  let profile = null;
  try {
    profile = await minecraftProfile(mc.token);
  } catch (e) {
    // no Java profile: either Java without a name yet, or no Java at all
    if (e.code !== 'noprofile' || owned.java) throw e;
  }
  if (!profile) {
    if (!xboxXsts) throw new AuthError('На этом аккаунте нет Minecraft: Java Edition, а профиль Xbox сейчас недоступен — попробуйте ещё раз.', 'nogame');
    return addXboxAccount(xboxXsts, secrets, owned);
  }
  const uuid = config.dashUuid(profile.id);
  const id = `msa:${String(profile.id).replace(/-/g, '')}`;

  config.mutate((c) => {
    const existing = c.accounts.find((a) => a.id === id);
    const acc = existing || { id, type: 'msa' };
    acc.name = profile.name;
    acc.uuid = uuid;
    acc.xuid = xboxXsts ? xboxXsts.xuid : acc.xuid || '';
    acc.gamertag = xboxXsts ? xboxXsts.gamertag : acc.gamertag || '';
    delete acc.needsLogin;
    if (!existing) c.accounts.unshift(acc);
    c.activeAccount = id;
  }, { silent: true });
  config.setSecrets(id, secrets);
  config.mutate(() => {}); // persist + notify, now that the vault exists
  log.info(`Signed in as ${profile.name} (${uuid})${xboxXsts ? `, Xbox: ${xboxXsts.gamertag}` : ''}.`);
  return config.publicAccount(config.get().accounts.find((a) => a.id === id));
}

// No Java on the account: it stays for what Xbox gives — Bedrock, friends,
// parties — and plays Java offline under the gamertag (no licensed servers).
function addXboxAccount(xsts, secrets, owned) {
  const id = `xbox:${xsts.xuid}`;
  const name = javaName(xsts.gamertag);
  config.mutate((c) => {
    const existing = c.accounts.find((a) => a.id === id);
    const acc = existing || { id, type: 'xbox' };
    acc.name = name;
    acc.uuid = config.offlineUuid(name);
    acc.xuid = xsts.xuid;
    acc.gamertag = xsts.gamertag;
    acc.bedrock = !!owned.bedrock;
    delete acc.needsLogin;
    if (!existing) c.accounts.unshift(acc);
    c.activeAccount = id;
  }, { silent: true });
  config.setSecrets(id, secrets);
  config.mutate(() => {});
  log.info(`Signed in to Xbox as ${xsts.gamertag}: no Java Edition on this account — Java plays offline under the gamertag.`);
  return { ...config.publicAccount(config.get().accounts.find((a) => a.id === id)), noJava: true };
}

// ---- keeping tokens fresh ---------------------------------------------------

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

function markNeedsLogin(id) {
  config.mutate((c) => {
    const a = c.accounts.find((x) => x.id === id);
    if (a) a.needsLogin = true;
  });
}

async function ensureXbl(id, s) {
  const now = Date.now();
  if (s.xbl && s.xblExp > now + 120000) return;
  if (!(s.msaAccess && s.msaExp > now + 120000)) {
    if (!s.msaRefresh) throw new AuthError('Нужно войти в аккаунт Microsoft.', 'expired');
    let t;
    try {
      t = await msaTokenRequest({ grant_type: 'refresh_token', refresh_token: s.msaRefresh });
    } catch (e) {
      if (e.code === 'expired') markNeedsLogin(id);
      throw e;
    }
    s.msaAccess = t.access_token;
    if (t.refresh_token) s.msaRefresh = t.refresh_token;
    s.msaExp = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  }
  const x = await xblAuthenticate(s.msaAccess);
  s.xbl = x.token;
  s.xblExp = x.exp;
  s.uhs = x.uhs;
}

function minecraftToken(id) {
  return withLock(id, async () => {
    const s = config.getSecrets(id);
    if (!s || !s.msaRefresh) {
      markNeedsLogin(id);
      throw new AuthError('Нужно войти в аккаунт Microsoft.', 'expired');
    }
    if (s.mc && s.mcExp > Date.now() + 5 * 60000) return s.mc;
    await ensureXbl(id, s);
    const xs = await xstsAuthorize(s.xbl, RP_MINECRAFT);
    const mc = await minecraftLogin(xs);
    s.mc = mc.token;
    s.mcExp = mc.exp;
    config.setSecrets(id, s);
    return s.mc;
  });
}

function xboxAuth(id) {
  return withLock(id, async () => {
    const s = config.getSecrets(id);
    if (!s || !s.msaRefresh) {
      markNeedsLogin(id);
      throw new AuthError('Нужно войти в аккаунт Microsoft.', 'expired');
    }
    if (!(s.xsts && s.xstsExp > Date.now() + 5 * 60000)) {
      await ensureXbl(id, s);
      const xs = await xstsAuthorize(s.xbl, RP_XBOX);
      s.xsts = xs.token;
      s.xstsUhs = xs.uhs;
      s.xstsExp = xs.exp;
      config.setSecrets(id, s);
      const acc = config.get().accounts.find((a) => a.id === id);
      if (acc && (acc.xuid !== xs.xuid || acc.gamertag !== xs.gamertag)) {
        config.mutate((c) => {
          const a = c.accounts.find((x) => x.id === id);
          if (a) {
            a.xuid = xs.xuid;
            a.gamertag = xs.gamertag;
          }
        });
      }
    }
    const acc = config.get().accounts.find((a) => a.id === id) || {};
    return { header: `XBL3.0 x=${s.xstsUhs};${s.xsts}`, xuid: acc.xuid || '' };
  });
}

// ---- accounts ---------------------------------------------------------------

function activeAccount() {
  const c = config.get();
  return c.accounts.find((a) => a.id === c.activeAccount) || c.accounts[0] || null;
}

function selectAccount(id) {
  config.mutate((c) => {
    if (c.accounts.some((a) => a.id === id)) c.activeAccount = id;
  });
}

function removeAccount(id) {
  config.setSecrets(id, null);
  config.mutate((c) => {
    c.accounts = c.accounts.filter((a) => a.id !== id);
    if (!c.accounts.length) c.accounts.push(config.offlineAccount('Player'));
    if (!c.accounts.some((a) => a.id === c.activeAccount)) c.activeAccount = c.accounts[0].id;
  });
}

function addOffline(name) {
  const acc = config.offlineAccount(name);
  config.mutate((c) => {
    if (!c.accounts.some((a) => a.id === acc.id)) c.accounts.push(acc);
    c.activeAccount = acc.id;
    config.rememberNickname(acc.name);
  });
  return acc;
}

// What the game is started with. A Microsoft token that can't be refreshed
// because the network is down still launches (singleplayer works without
// it); one Microsoft actually refused does not.
//
// Guests and Xbox accounts without Java play offline — an Xbox account under
// its gamertag as a Java name (javaName). Licensed servers turn such a player
// away; everything else (singleplayer, LAN, offline-mode servers) works.
async function sessionForLaunch() {
  const acc = activeAccount();
  if (!acc) throw new AuthError('Нет аккаунта.');
  // a nick of its own (javaNick): offline under it, a licence too — like an account without Java
  const nick = String(acc.javaNick || '').trim();
  if (acc.type !== 'msa' || nick) {
    const name = nick || acc.name;
    return { name, uuid: config.offlineUuid(name), accessToken: '0', userType: 'legacy', xuid: '', offline: true, accountId: acc.id };
  }
  let token;
  try {
    token = await minecraftToken(acc.id);
  } catch (e) {
    const s = config.getSecrets(acc.id);
    if (e.code !== 'expired' && e.code !== 'xsts' && s && s.mc) {
      log.warn(`Couldn't refresh the Minecraft token (${e.message}) — launching with the cached one.`);
      token = s.mc;
    } else {
      throw e;
    }
  }
  return { name: acc.name, uuid: acc.uuid, accessToken: token, userType: 'msa', xuid: acc.xuid || '', accountId: acc.id };
}

async function clearBrowserSession() {
  const s = session.fromPartition(AUTH_PARTITION);
  await s.clearStorageData();
  await s.clearCache();
}

module.exports = {
  AuthError,
  signInInteractive,
  cancelSignIn,
  minecraftToken,
  xboxAuth,
  minecraftProfile,
  activeAccount,
  selectAccount,
  removeAccount,
  addOffline,
  sessionForLaunch,
  clearBrowserSession,
};
