---
name: debz-ai-browser-automation
description: "Browser automation and virtual desktop control on Debz AI."
version: 1.0.0
author: Debz AI
license: MIT
platforms: [android, linux]
metadata:
  hermes:
    tags: [debz-ai, browser, computer-use, playwright, chromium, automation, frontend-testing]
    related_skills: [computer-use]
---

# Debz AI — Browser & Computer-Use Automation

Skill ini mendeskripsikan seluruh stack browser automation + computer-use di
lingkungan Debz AI (Alpine proot/chroot di Termux Android).

## Environment Context

- OS: Alpine Linux 3.24 (musl libc, proot/chroot dari Termux)
- Runtime: Python 3.14.7 + Node.js v24.18.1
- **pip playwright TIDAK BISA diinstall** — musl punya wheel yang tidak tersedia
  di PyPI. Solusi: gunakan **npm Playwright** sebagai ganti.
- Chromium native Alpine tersedia via `apk add chromium`.

## Stack Components

| Komponen | Lokasi | Port |
|---|---|---|
| Backend AI (Python Flask) | `/root/debz_ai/backend.py` | **999** (0.0.0.0) |
| Browser daemon (Playwright+Chromium) | `/root/debz_ai/pw_daemon.sh` | **9222** (127.0.0.1) |
| CUA driver (Xvfb :99) | `/root/debz_ai/cua_driver.py` | :99 (virtual) |
| pw_browser.mjs (wrapper Node) | `/root/debz_ai/pw_browser.mjs` | via daemon |
| Web UI PHP | port **666** | via nginx |
| Backend lawas Termux (DUDE!) | **PORT 8000 — SUDAH DIMATIKAN** | ❌ |

## Browser Automation (Playwright Daemon)

### Start & Status
```bash
/root/debz_ai/pw_daemon.sh start    # mulai/restart daemon
/root/debz_ai/pw_daemon.sh status   # cek status + port
```

### Perintah via Node wrapper
```bash
node /root/debz_ai/pw_browser.mjs goto https://example.com
node /root/debz_ai/pw_browser.mjs title
node /root/debz_ai/pw_browser.mjs text h1
node /root/debz_ai/pw_browser.mjs click 'button.submit'
node /root/debz_ai/pw_browser.mjs type 'input#search' 'keyword'
node /root/debz_ai/pw_browser.mjs press Enter
node /root/debz_ai/pw_browser.mjs wait 2000
node /root/debz_ai/pw_browser.mjs eval 'document.title'
node /root/debz_ai/pw_browser.mjs screenshot /root/debz_ai/screenshots/shot.png
node /root/debz_ai/pw_browser.mjs content
node /root/debz_ai/pw_browser.mjs close
```

State **persistent antar step** — daemon pegang page/context sendiri.

### Perintah via Python helper
```python
import requests
requests.post('http://127.0.0.1:999/api/browser', json={
    'command': 'goto', 'url': 'https://example.com'
})
```

## CUA Driver (Layar Virtual)

Layar Xvfb 1280x800 di display :99, window manager Openbox, input via xdotool.

### Perintah via Node wrapper / API
```bash
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"status"}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"screenshot"}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"click","x":640,"y":400}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"type","text":"hello"}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"launch","cmd":"chromium --headless"}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"key","key":"ctrl+a"}'
curl -X POST http://127.0.0.1:999/api/cua -d '{"action":"scroll","dy":-1,"times":3}'
```

### Screenshot (visual state)
```
POST /api/screenshot  → { base64, width, height, display }
```
Gunakan untuk "melihat" layar virtual. Model harus **support vision** supaya
bisa baca screenshot.

## AI Tool Integration (agent.php)

- Tool `computer_use` → endpoint `/api/cua` (di `native_tool_endpoint()`)
- Tool `browser` → endpoint `/api/browser`
- `native_tool_arg_summary()` sudah include kedua-duanya (log ringkas).
- Alur loop AI: `screenshot → lihat → tentuin koordinat → action → ulang`.

## Autostart (Boot)

Semua otomatis saat device boot:
```
Android boot → Magisk service.sh → chroot Alpine → /root/start.sh
  ├─ Backend AI (port 999)
  ├─ Web UI PHP (port 666)
  ├─ Nginx + cloudflared
  └─ Browser daemon Chromium (port 9222) ← baru ditambah 2026-09-07
```

Host file: `/data/adb/modules/XTreme_Tweak_Debz/service.sh`
yang memanggil `chroot /data/delinux /bin/bash -c "/root/start.sh"`.

## Recovery (Setelah Reboot Manual)

Kalau backend perlu restart manual dari Alpine chroot:
```bash
cd /root/debz_ai
nohup python3 backend.py > /root/debz_ai/logs/backend.log 2>&1 &
/root/debz_ai/pw_daemon.sh start
```

## Common Pitfall: pip playwright

**JANGAN** `pip install playwright` di Alpine/musl — akan error:
`No matching distribution found for playwright` (hanya tersedia manylinux/glibc).
Gunakan selalu `npm install -g playwright@1.63.0` + `apk add chromium`.

## Referensi

Notes di notes.db: `dev:browser-stack`, `dev:cua-driver-stack`,
`dev:agent-native-tools`, `dev:startup-autostart`, `dev:cleanup-ghost-proc`.
File terkait: `cua_driver.py`, `pw_daemon.sh`, `pw_browser.mjs`,
`browser.py`, `backend.py`, `agent.php`, `/root/start.sh`.
