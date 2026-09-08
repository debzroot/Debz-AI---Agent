# Debz AI — c0n73xt Platform Agent

AI agent mandiri dengan **WebUI**, **CLI terminal**, dan **server tools** (browser automation, file system, shell, dll).

## 🚀 Quick Start

```bash
git clone <repo-url> debz_ai
cd debz_ai
./debz.sh
```

Script otomatis:
1. Install dependency sistem (PHP, Python3, Node, Chromium) sesuai distro (apk/apt/dnf)
2. Setup virtualenv Python + requirements
3. Pasang command `debz-term` ke PATH
4. Start semua service

### Output setelah start

```
  🌐 WebUI      → http://127.0.0.1:666
  💻 CLI        → ketik debz-term
  ⚙️  Konfigurasi → API key & model diatur lewat WebUI (tombol ⚙️ Settings)
  🛠️  Tool server → http://127.0.0.1:999
```

## 📖 Perintah `debz.sh`

| Perintah | Fungsi |
|---|---|
| `./debz.sh` / `./debz.sh start` | Install dep (jika perlu) + start semua service |
| `./debz.sh install` | Install dependency aja (tanpa start) |
| `./debz.sh stop` | Stop semua service |
| `./debz.sh status` | Cek status semua service |
| `./debz.sh term` | Jalankan CLI terminal |
| `./debz.sh help` | Bantuan |

## 🧩 Komponen

| Komponen | File | Port |
|---|---|---|
| WebUI | `index.php` (PHP built-in server) | **666** |
| Tool server | `backend.py` (Flask) | **999** |
| CLI terminal | `debz-term.py` (Rich + prompt_toolkit) | — |
| Browser daemon | `pw_daemon.mjs` (Playwright + Chromium) | **9222** |

## ⚙️ Konfigurasi

- **API key & model** → diatur lewat WebUI (tombol **⚙️ Settings** di pojok kanan). Tersimpan di `.ai-providers.json`.
- **Config file** → `.ai-config.ini` (token tool server, port, max token).
- Pada clone pertama, config dibuat otomatis dari `.ai-config.example` & `.ai-providers.example`. **Jangan commit file config asli** (sudah ada di `.gitignore`).

## 💻 CLI Terminal

```bash
debz-term
```

Perintah penting di CLI:

| Perintah | Fungsi |
|---|---|
| `/model` | Ganti provider/model |
| `/tools on\|off` | Aktifkan/nonaktifkan tools |
| `/allow on\|off` | Auto-approve perintah berbahaya |
| `!<perintah>` | Jalankan shell langsung (via tool server) |
| `/save` `/load` | Simpan/muat session |
| `/export` | Export chat ke Markdown |
| `/retry` | Ulangi request yang di-hold |
| `/reset` `/new` | Reset session |

Contoh non-interaktif:
```bash
debz-term --exec "buatkan script python untuk backup folder" --json
```

## 🧪 Requirement

- Linux (Alpine/Debian/Ubuntu/Fedora) — script auto-detect package manager
- PHP CLI 8+, Python 3.10+, Node 18+ (untuk browser daemon), Chromium (opsional)
- Koneksi internet saat install pertama

## 🛑 Stop

```bash
./debz.sh stop
```

## 🔒 Catatan Keamanan

- Tool server (`backend.py`) punya filter perintah berbahaya (`rm -rf /`, `dd`, `mkfs`, dll) — butuh approval eksplisit.
- WebUI punya proteksi password + rate-limit login.
- Ganti `AI_TOOLS_TOKEN` di `.ai-config.ini` sebelum dipakai publik.