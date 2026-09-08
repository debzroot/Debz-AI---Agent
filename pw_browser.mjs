#!/usr/bin/env node
/**
 * pw_browser.mjs — CDP-native browser CLI wrapper untuk AI automation agent.
 * REWRITE: tanpa Playwright (playwright-core TIDAK support platform Android/termux).
 * Pakai raw Chrome DevTools Protocol (CDP) via WebSocket native (Node 22+).
 * Prioritas: konek daemon persistent (state kebawa) di port 9222, fallback launch sendiri.
 *
 * Usage:
 *   node pw_browser.mjs <command> [args...]
 *
 * Commands:
 *   goto <url>                 Buka URL & tunggu sampai load
 *   content                    Dump HTML halaman saat ini
 *   text                       Dump teks (body innerText)
 *   title                      Ambil judul halaman
 *   screenshot <path.png>      Screenshot (viewport)
 *   click <selector>           Klik elemen (CSS selector) + boleh arg2=index
 *   type <selector> <text>     Ketik teks ke input (set value + input event)
 *   press <key>                Tekan tombol (Enter, Tab, Backspace, ...)
 *   wait <ms>                  Tunggu milidetik
 *   eval <js>                  Jalankan JS di halaman, print JSON hasil
 *   close                      Tutup page (daemon tetap hidup)
 */
import fs from 'node:fs';

const [, , cmd, ...rest] = process.argv;

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/data/data/com.termux/files/usr/bin/chromium-browser';
const PORT = process.env.PW_PORT || '9222';
const CDP_HTTP = 'http://127.0.0.1:' + PORT;

const out = (data) => { console.log(JSON.stringify(data)); };
const fail = (err) => { out({ ok: false, error: String(err && err.message || err) }); process.exit(1); };

// ---------- helper request ----------
async function httpJson(url, timeout = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---------- CDP client ----------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket gagal: ' + wsUrl));
    });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Page.loadEventFired') {
        cdp._loadFired = true;
      }
    };
    ws.onclose = () => { for (const { reject } of cdp.pending.values()) reject(new Error('CDP closed')); cdp.pending.clear(); };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function getTargetUrl(id) {
  // cari daemon, kalau ada pakai page pertama yg ada
  try {
    const targets = await httpJson(CDP_HTTP + '/json/list', 3000);
    // prefer page target (type == page)
    const pages = targets.filter(t => t.type === 'page');
    if (pages.length) return pages[0].webSocketDebuggerUrl;
    // fallback: buat tab baru via http
    const created = await fetch(CDP_HTTP + '/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
    return created.webSocketDebuggerUrl;
  } catch (e) {
    throw new Error('Daemon tidak aktif di port ' + PORT + ': ' + e.message);
  }
}

async function launchFreshTab() {
  // Fallback: kalau daemon hidup tapi target cuma browser (service worker), buat tab baru
  const created = await fetch(CDP_HTTP + '/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
  return created.webSocketDebuggerUrl;
}

let _cdp = null;
let _wsUrl = null;

async function connect() {
  if (_cdp && _wsUrl) return _cdp;
  try {
    _wsUrl = await getTargetUrl();
  } catch (e) {
    // daemon mati → coba launch sendiri (headless local, non-persistent)
    return launchLocal();
  }
  _cdp = await CDP.connect(_wsUrl);
  await _cdp.send('Page.enable');
  await _cdp.send('Runtime.enable');
  await _cdp.send('DOM.enable');
  // pindah ke frame utama reliable
  await _cdp.send('Page.bringToFront').catch(() => {});
  return _cdp;
}

let _localBrowser = null;
async function launchLocal() {
  // launch chromium mandiri dengan debugging port acak, attach langsung
  const tmpPort = 9300 + Math.floor(Math.random() * 300);
  const profile = '/data/data/com.termux/files/home/.cdp_local_' + process.pid;
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-setuid-sandbox', '--no-zygote', '--disable-software-rasterizer',
    '--remote-debugging-port=' + tmpPort, '--user-data-dir=' + profile,
    'about:blank'
  ];
  const { spawn } = await import('node:child_process');
  _localBrowser = spawn(CHROMIUM_BIN, args, { stdio: 'ignore', detached: true });
  // tunggu port siap
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await httpJson('http://127.0.0.1:' + tmpPort + '/json/list', 2000);
      const p = pages.find(t => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!wsUrl) throw new Error('Gagal launch Chrome lokal (port ' + tmpPort + ')');
  _cdp = await CDP.connect(wsUrl);
  await _cdp.send('Page.enable');
  await _cdp.send('Runtime.enable');
  await _cdp.send('DOM.enable');
  return _cdp;
}

// ---------- evaluasi helper ----------
async function evalJS(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('JS error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result?.value;
}

// ---------- main ----------
async function main() {
  // perintah tanpa perlu connect
  if (cmd === 'wait') {
    await new Promise(r => setTimeout(r, parseInt(rest[0] || '1000', 10)));
    out({ ok: true });
    process.exit(0);
  }

  let cdp;
  try {
    if (cmd === 'close') {
      cdp = await connect();
      const p = await evalJS(cdp, 'location.href').catch(() => null);
      cdp.close(); _cdp = null;
      out({ ok: true, closed_at_current: p });
      process.exit(0);
    }

    cdp = await connect();

    switch (cmd) {
      case 'goto': {
        const url = rest[0];
        await cdp.send('Page.navigate', { url });
        // tunggu load event
        await new Promise(r => setTimeout(r, 1500));
        for (let i = 0; i < 30; i++) {
          const ready = await evalJS(cdp, 'document.readyState').catch(() => '');
          if (ready === 'complete' || ready === 'interactive') break;
          await new Promise(r => setTimeout(r, 300));
        }
        const info = await evalJS(cdp, 'JSON.stringify({title: document.title, url: location.href})');
        out({ ok: true, ...JSON.parse(info) });
        break;
      }
      case 'content': {
        const html = await evalJS(cdp, 'document.documentElement.outerHTML');
        out({ ok: true, html });
        break;
      }
      case 'text': {
        const text = await evalJS(cdp, 'document.body ? document.body.innerText : ""');
        out({ ok: true, text });
        break;
      }
      case 'title': {
        const title = await evalJS(cdp, 'document.title');
        out({ ok: true, title });
        break;
      }
      case 'screenshot': {
        const path = rest[0] || process.env.PW_SHOT || 'screenshots/pw_shot.png';
        await cdp.send('Page.enable');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        // (directory dibuat dari path di bawah)
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path, Buffer.from(shot.data, 'base64'));
        out({ ok: true, path });
        break;
      }
      case 'click': {
        const selector = rest[0];
        const idx = parseInt(rest[1] || '0', 10);
        const q = `document.querySelectorAll(${JSON.stringify(selector)})[${idx}]`;
        const r = await evalJS(cdp, `(() => { const el = ${q}; if(!el) throw new Error('selector tidak ditemukan: ${selector}'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`);
        const { x, y } = JSON.parse(r);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
        out({ ok: true, clicked: selector + (idx ? '#' + idx : ''), at: { x: Math.round(x), y: Math.round(y) } });
        break;
      }
      case 'type': {
        const selector = rest[0];
        const text = rest[1] || '';
        // fokus + set value via focus + native setter biar trigger React/Vue
        await evalJS(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('input tidak ditemukan: ${selector}'); el.focus(); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        out({ ok: true, typed_into: selector });
        break;
      }
      case 'press': {
        const key = rest[0] || 'Enter';
        // map key ke CDP key code sederhana
        const map = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
        const code = map[key] || (key.length === 1 ? key.charCodeAt(0) : null);
        await evalJS(cdp, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,keyCode:${code}}));document.activeElement.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true,keyCode:${code}}))`);
        if (key === 'Enter') {
          // submit form kalau ada
          await evalJS(cdp, `(() => { const el = document.activeElement; const f = el && el.form; if (f && typeof f.submit === 'function') { if (el && el.type !== 'submit') el.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()`);
        }
        out({ ok: true, key });
        break;
      }
      case 'eval': {
        const js = rest.join(' ');
        const val = await evalJS(cdp, js);
        out({ ok: true, result: typeof val === 'string' ? val : JSON.stringify(val) });
        break;
      }
      default:
        out({ ok: false, error: 'command tidak dikenal: ' + cmd, usage: 'goto|content|text|title|screenshot|click|type|press|wait|eval|close' });
    }
  } catch (e) {
    fail(e);
  } finally {
    if (cdp && cmd !== 'close') { try { cdp.close(); } catch {} }
    if (_localBrowser && cmd !== 'close') {
      try { _localBrowser.kill(); } catch {}
      const profile = '/data/data/com.termux/files/home/.cdp_local_' + process.pid;
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

main().catch(fail);
