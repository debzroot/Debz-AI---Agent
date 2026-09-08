#!/usr/bin/env node
/**
 * pw_daemon.mjs — Browser daemon persistent pakai launchPersistentContext.
 * Context+page dibuat OLEH DAEMON (bukan client), jadi hidup terus & state kebawa
 * antar panggilan AI via CDP.
 */
import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs';

const PORT = process.env.PW_PORT || '9222';
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
const PROFILE = '/tmp/pw_profile';

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM_BIN,
  headless: true,
  chromiumSandbox: false,
  viewport: { width: 1280, height: 800 },
  args: [
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-setuid-sandbox',
    '--no-zygote',
    '--disable-software-rasterizer',
  ],
});

const page = context.pages()[0] || await context.newPage();
console.log(`[pw_daemon] chromium persistent up di port ${PORT}, pid=${process.pid} | initial page: ${page.url()}`);
process.on('SIGTERM', async () => { try { await context.close(); } catch {} process.exit(0); });
setInterval(() => {}, 1 << 30); // keep alive