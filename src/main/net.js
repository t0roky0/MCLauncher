'use strict';
// HTTP for everything the launcher downloads or calls.
//
// Node's own fetch (undici) with keep-alive, so the few thousand asset
// requests of a fresh install reuse a handful of connections instead of
// opening one each (Chromium's when a system proxy is on: fetchVia). Every download is hashed while it streams to a .part
// file and only renamed into place once size and SHA-1 both match — a file
// that is on disk under its real name is a file that was verified.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const userAgent = () => `MCLauncher/${app.getVersion()} (Windows; Electron)`;

// Through the system proxy when there is one for the address (a VPN app's
// "system proxy" mode): Chromium's own fetch, which goes the way the
// window's requests go; else Node's (undici), straight, with keep-alive.
async function fetchVia(url, init) {
  const via = await require('./proxy').forUrl(url).catch(() => null);
  // no-store: as undici, never an answer kept from before (a profile just changed)
  return via ? require('electron').net.fetch(url, { cache: 'no-store', ...init }) : fetch(url, init);
}

class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body || '';
    this.url = url;
  }
}

function abortError() {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// undici reports every network failure as "fetch failed" with the real
// reason tucked into .cause; surface that instead.
function describe(e) {
  if (!e) return 'unknown error';
  if (e.name === 'HttpError' || e.cancelled) return e.message;
  const cause = e.cause || {};
  const code = cause.code || e.code;
  const map = {
    ENOTFOUND: 'нет соединения с интернетом (DNS)',
    ECONNRESET: 'соединение сброшено',
    ECONNREFUSED: 'сервер отклонил соединение',
    ETIMEDOUT: 'превышено время ожидания',
    UND_ERR_CONNECT_TIMEOUT: 'превышено время ожидания подключения',
    UND_ERR_SOCKET: 'ошибка сокета',
    EAI_AGAIN: 'нет соединения с интернетом (DNS)',
  };
  if (code && map[code]) return `${map[code]} (${code})`;
  if (e.message === 'timeout' || cause.message === 'timeout') return 'превышено время ожидания';
  return cause.message ? `${e.message}: ${cause.message}` : e.message;
}

function linkSignals(signal, timeoutMs) {
  const ctrl = new AbortController();
  let timer = null;
  const arm = () => {
    if (!timeoutMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  };
  const onAbort = () => ctrl.abort(abortError());
  if (signal) {
    if (signal.aborted) ctrl.abort(abortError());
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  arm();
  return {
    signal: ctrl.signal,
    rearm: arm,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeout = 20000, signal, retries = 1, expect = 'json' } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const link = linkSignals(signal, timeout);
    try {
      const res = await fetchVia(url, {
        method,
        headers: { 'User-Agent': userAgent(), ...headers },
        body,
        signal: link.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, text, url);
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastErr = err;
          await delay(900 * (attempt + 1));
          continue;
        }
        throw err;
      }
      if (expect === 'json') {
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      }
      if (expect === 'text') return await res.text();
      if (expect === 'buffer') return Buffer.from(await res.arrayBuffer());
      if (expect === 'none') {
        await res.arrayBuffer().catch(() => null);
        return null;
      }
      return res;
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < retries) await delay(800 * (attempt + 1));
    } finally {
      link.done();
    }
  }
  const err = new Error(describe(lastErr));
  err.cause = lastErr;
  throw err;
}

const getJson = (url, o = {}) => request(url, { ...o, expect: 'json' });
const getText = (url, o = {}) => request(url, { ...o, expect: 'text' });
const getBuffer = (url, o = {}) => request(url, { ...o, expect: 'buffer' });

function postJson(url, data, o = {}) {
  return request(url, {
    ...o,
    method: o.method || 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(o.headers || {}) },
    body: JSON.stringify(data),
  });
}

function postForm(url, fields, o = {}) {
  return request(url, {
    ...o,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(o.headers || {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function fileMatches(file, size) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() && (!size || st.size === size);
  } catch {
    return false;
  }
}

// Streams `url` to `dest`, verifying `size` and `sha1` when given.
// onBytes(delta) is called as data arrives (and with a negative delta if a
// failed attempt has to be rolled back), which is what drives the speed
// read-out in the UI.
async function download(url, dest, { sha1, size, signal, onBytes, retries = 4, idleTimeout = 30000 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let written = 0;
    const link = linkSignals(signal, idleTimeout);
    try {
      const res = await fetchVia(url, { headers: { 'User-Agent': userAgent() }, signal: link.signal, redirect: 'follow' });
      if (!res.ok) throw new HttpError(res.status, '', url);
      const hash = sha1 ? crypto.createHash('sha1') : null;
      const fh = await fsp.open(tmp, 'w');
      try {
        for await (const chunk of res.body) {
          link.rearm();
          await fh.write(chunk);
          if (hash) hash.update(chunk);
          written += chunk.length;
          if (onBytes) onBytes(chunk.length);
        }
      } finally {
        await fh.close();
      }
      if (size && written !== size) {
        throw new Error(`${path.basename(dest)}: размер ${written} вместо ${size}`);
      }
      if (hash) {
        const got = hash.digest('hex');
        if (got !== String(sha1).toLowerCase()) throw new Error(`${path.basename(dest)}: не совпал SHA-1`);
      }
      await fsp.rename(tmp, dest);
      return written;
    } catch (e) {
      if (onBytes && written) onBytes(-written);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (signal && signal.aborted) throw abortError();
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) {
        throw new Error(`${path.basename(dest)}: ${e.message} (${url})`);
      }
      lastErr = e;
      if (attempt < retries) await delay(1000 * (attempt + 1));
    } finally {
      link.done();
    }
  }
  throw new Error(`${path.basename(dest)}: ${describe(lastErr)}`);
}

// Runs fn over items with at most `limit` in flight. Rejects on the first
// failure, after letting in-flight work settle.
async function pool(items, limit, fn, signal) {
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      if (signal && signal.aborted) throw abortError();
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure = failure || e;
        throw e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const results = await Promise.allSettled(workers);
  if (failure) throw failure;
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}

module.exports = {
  HttpError,
  abortError,
  describe,
  request,
  getJson,
  getText,
  getBuffer,
  postJson,
  postForm,
  download,
  fileMatches,
  pool,
  delay,
  userAgent,
};
