#!/usr/bin/env node
/**
 * pw_daemon.mjs — Browser daemon persistent via Chrome DevTools Protocol (CDP).
 * REWRITE: tanpa Playwright (platform Android unsupported utk playwright-core).
 * Jalanin chromium-browser headless --remote-debugging-port, state hidup terus.
 * AI agent connect via CDP (port 9222) pakai pw_browser.mjs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = process.env.PW_PORT || '9222';
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/data/data/com.termux/files/usr/bin/chromium-browser';
const PROFILE = process.env.PW_PROFILE || '/data/data/com.termux/files/home/.cdp_profile';
const LOG = process.env.PW_DAEMON_LOG || '/data/data/com.termux/files/home/debz_ai/logs/pw_daemon.log';
const CDP_HTTP = 'http://127.0.0.1:' + PORT;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { console.error(line); }
}

async function isUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(CDP_HTTP + '/json/version', { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

async function start() {
  if (await isUp()) {
    log('Daemon sudah aktif di port ' + PORT);
    console.log('[pw_daemon] sudah aktif di port ' + PORT);
    process.exit(0);
  }

  // cleanup profile lama yang rusak kadang
  fs.mkdirSync(PROFILE, { recursive: true });

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-zygote',
    '--disable-software-rasterizer',
    '--disable-features=VizDisplayCompositor',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];

  log('Launch chromium: ' + CHROMIUM_BIN);
  const chrome = spawn(CHROMIUM_BIN, args, { stdio: 'ignore', detached: true });
  chrome.unref();
  chrome.on('error', (e) => { log('ERROR spawn chromium: ' + e.message); console.error('[pw_daemon] ERROR: ' + e.message); process.exit(1); });
  chrome.on('exit', (code, sig) => {
    log('Chromium exit code=' + code + ' signal=' + sig);
    // jangan exit biar daemon control; tapi kalau child mati, kita keluar agar gambaran jelas
  });

  // tunggu port aktif
  for (let i = 0; i < 60; i++) {
    if (await isUp()) {
      log('Daemon UP di port ' + PORT + ' (pid chromium=' + chrome.pid + ')');
      console.log('[pw_daemon] up di port ' + PORT + ', pid chromium=' + chrome.pid);
      // tahan proses daemon ini (jangan exit) supaya jadi supervisor & log tetap
      setInterval(() => {}, 1 << 30);
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!(await isUp())) {
    log('FAILED: chromium tidak mau up di port ' + PORT);
    console.error('[pw_daemon] FAILED: chromium tidak up di port ' + PORT);
    process.exit(1);
  }
}

async function stop() {
  try {
    const targets = await fetch(CDP_HTTP + '/json/version').then(r => r.json()).catch(() => null);
    log('stop dipanggil');
  } catch {}
  // kill oleh process manager (pkill pw_daemon.mjs + chromium)
}

const cmd = process.argv[2] || 'start';
process.on('SIGTERM', () => {
  log('SIGTERM diterima, shutdown');
  try { process.kill(undefined, 'SIGTERM'); } catch {}
  process.exit(0);
});

if (cmd === 'stop' || cmd === 'status') {
  let up = await isUp();
  log('cmd=' + cmd + ' up=' + up);
  if (cmd === 'status') {
    console.log(up ? 'daemon AKTIF di port ' + PORT : 'daemon MATI');
    process.exit(0);
  }
  // stop
  if (up) {
    try { await fetch(CDP_HTTP + '/json/close/all'); } catch {}
  }
  console.log('daemon di-stop');
  process.exit(0);
}

log('pw_daemon start, port=' + PORT + ' bin=' + CHROMIUM_BIN);
start().catch((e) => {
  log('FATAL: ' + e.message);
  console.error('[pw_daemon] FATAL: ' + e.message);
  process.exit(1);
});
