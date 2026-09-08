#!/usr/bin/env node
/**
 * pw_browser.mjs — Playwright browser CLI wrapper utk AI automation agent.
 * Pakai Chromium native Alpine (musl). Prioritas: konek daemon persistent (state kebawa),
 * fallback: launch sendiri kalau daemon mati.
 *
 * Usage:
 *   node pw_browser.mjs <command> [args...]
 *
 * Commands:
 *   goto <url>                 Buka URL & tunggu sampai load
 *   content                    Dump HTML halaman saat ini
 *   text                       Dump teks (body innerText)
 *   title                      Ambil judul halaman
 *   screenshot <path.png>      Screenshot (full page)
 *   click <selector>           Klik elemen (CSS selector) + boleh arg2=index
 *   type <selector> <text>     Ketik teks ke input
 *   press <key>                Tekan tombol (Enter, Tab, Backspace, ...)
 *   wait <ms>                  Tunggu milidetik
 *   eval <js>                  Jalankan JS di halaman, print JSON hasil
 *   close                      Tutup browser/daemon
 */
import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const [, , cmd, ...rest] = process.argv;

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
const CDP_URL = 'http://127.0.0.1:' + (process.env.PW_PORT || '9222');

const out = (data) => { console.log(JSON.stringify(data)); };
const fail = (err) => { out({ ok: false, error: String(err && err.message || err) }); process.exit(1); };

let _browser = null, _page = null, _ctx = null;

async function connect() {
  // coba konek ke daemon persistent
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
  } catch (_) {
    return null;
  }
}

async function launchNew() {
  const opts = {
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox', '--no-zygote', '--disable-software-rasterizer'],
  };
  if (fs.existsSync(CHROMIUM_BIN)) opts.executablePath = CHROMIUM_BIN;
  return chromium.launch(opts);
}

async function getPage() {
  if (_page) return _page;
  // 1) daemon persistent
  const daemon = await connect();
  if (daemon) {
    _browser = daemon;
    for (const ctx of daemon.contexts()) {
      const pages = ctx.pages();
      if (pages.length) {
        _ctx = ctx; _page = pages[0];
        return _page;
      }
    }
    _ctx = await daemon.newContext({ viewport: { width: 1280, height: 800 } });
    _page = await _ctx.newPage();
    return _page;
  }
  // 2) fallback launch lokal
  _browser = await launchNew();
  _ctx = await _browser.newContext({ viewport: { width: 1280, height: 800 } });
  _page = await _ctx.newPage();
  return _page;
}

async function main() {
  switch (cmd) {
    case 'goto': {
      const page = await getPage();
      await page.goto(rest[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
      out({ ok: true, title: await page.title(), url: page.url() });
      break;
    }
    case 'content': {
      const page = await getPage();
      out({ ok: true, html: await page.content() });
      break;
    }
    case 'text': {
      const page = await getPage();
      out({ ok: true, text: await page.evaluate(() => document.body ? document.body.innerText : '') });
      break;
    }
    case 'title': {
      const page = await getPage();
      out({ ok: true, title: await page.title() });
      break;
    }
    case 'screenshot': {
      const page = await getPage();
      const path = rest[0] || process.env.PW_SHOT || 'screenshots/pw_shot.png';
      await page.screenshot({ path, fullPage: true });
      out({ ok: true, path });
      break;
    }
    case 'click': {
      const page = await getPage();
      const selector = rest[0];
      const idx = parseInt(rest[1] || '0', 10);
      await page.locator(selector).nth(idx).click({ timeout: 15000 });
      out({ ok: true, clicked: selector + (idx ? '#' + idx : '') });
      break;
    }
    case 'type': {
      const page = await getPage();
      await page.fill(rest[0], rest[1] || '', { timeout: 15000 });
      out({ ok: true, typed_into: rest[0] });
      break;
    }
    case 'press': {
      const page = await getPage();
      await page.keyboard.press(rest[0] || 'Enter');
      out({ ok: true, key: rest[0] });
      break;
    }
    case 'wait': {
      await new Promise(r => setTimeout(r, parseInt(rest[0] || '1000', 10)));
      out({ ok: true });
      break;
    }
    case 'eval': {
      const page = await getPage();
      const res = await page.evaluate(new Function(rest.join(' ')));
      out({ ok: true, result: typeof res === 'string' ? res : JSON.stringify(res) });
      break;
    }
    case 'close': {
      if (_browser) { try { await _browser.close(); } catch (_) {} }
      _browser = null; _page = null; _ctx = null;
      out({ ok: true });
      break;
    }
    default:
      out({ ok: false, error: 'command tidak dikenal: ' + cmd, usage: 'goto|content|text|title|screenshot|click|type|press|wait|eval|close' });
  }
  process.exit(0);
}

main().catch(fail);