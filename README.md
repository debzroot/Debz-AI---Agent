# 🤖 Debz AI — c0n73xt Platform Agent

AI agent mandiri yang bisa diajak ngobrol sekaligus **jalanin perintah** (shell, file, browser) lewat satu terminal. Lengkap dengan **WebUI**, **CLI**, dan **server tools** — semua jalan di mesin kamu sendiri.

---

## ✨ Fitur

- 💬 **Chat AI** — pakai provider OpenAI-compatible apa aja (OpenRouter, OpenAI, Groq, Ollama lokal, dll)
- 🛠️ **Agent + Tools** — bisa eksekusi shell, baca/tulis file, buka browser, otomatis
- 🌐 **WebUI** di `http://127.0.0.1:666` — buat chat & atur konfigurasi
- 💻 **CLI terminal** (`debz-term`) — buat yang lebih nyaman di terminal
- 🔄 **Multi-provider** — bisa set beberapa provider + routing (fixed / round-robin / failover)
- 📦 **Auto-install** — sekali jalanin `./debz.sh`, semua dependency kepasang otomatis

---

## 🚀 Quick Start

```bash
git clone git@github.com:debzroot/Debz-AI---Agent.git debz_ai
cd debz_ai
./debz.sh
```

Script `debz.sh` otomatis:
1. Install dependency sistem (PHP, Python3, Node, Chromium) sesuai distro kamu
2. Setup virtualenv Python + dependency
3. Pasang command `debz-term` ke PATH
4. Start semua service

**Output kalau sukses:**

```
  🌐 WebUI      → http://127.0.0.1:666
  💻 CLI        → ketik debz-term
  ⚙️ Konfigurasi → API key & model diatur lewat WebUI (tombol ⚙️ Settings)
  🛠️ Tool server → http://127.0.0.1:999
```

---

## ⚙️ Setup Pertama Kali (WAJIB)

Setelah clone & start, project masih **belum punya API key** (default kosong, aman). Isi dulu biar bisa dipakai:

1. Buka **http://127.0.0.1:666** di browser
2. Klik tombol **⚙️ Settings** (pojok kanan atas)
3. Di kartu provider **OpenRouter (default)**:
   - **API Key** → isi key kamu (buat di [openrouter.ai/keys](https://openrouter.ai/keys) — gratis)
   - **Model** → pilih model, misal `openai/gpt-4o-mini`, atau klik **📂 Model** buat lihat daftar
   - Klik **Test Koneksi** dulu buat mastiin berhasil
   - Klik **Simpan**
4. Balik ke halaman chat, langsung bisa dipakai ✅

> 💡 **Bisa pakai provider lain juga** — di Settings, klik **+ Tambah Provider**, isi Base URL + API key + model. Yang penting endpoint-nya OpenAI-compatible (format `/v1`). Misal: OpenAI, Groq, Ollama lokal, atau server AI sendiri.

---

## 💻 CLI Terminal

```bash
debz-term
```

Perintah penting di CLI:

| Perintah | Fungsi |
|---|---|
| `/model` | Ganti provider/model |
| `/tools on` atau `/tools off` | Aktifkan / nonaktifkan tools |
| `/allow on` / `/allow off` | Auto-approve perintah berbahaya |
| `!<perintah>` | Jalanin shell langsung (via tool server) |
| `/save` / `/load` | Simpan / muat session |
| `/export` | Export chat ke Markdown |
| `/retry` | Ulangi request yang di-hold |
| `/reset` / `/new` | Reset session |

Contoh non-interaktif:
```bash
debz-term --exec "buatkan script python untuk backup folder" --json
```

---

## 📖 Perintah `debz.sh`

| Perintah | Fungsi |
|---|---|
| `./debz.sh` / `./debz.sh start` | Install dependency (kalau perlu) + start semua service |
| `./debz.sh install` | Install dependency aja (tanpa start) |
| `./debz.sh stop` | Stop semua service |
| `./debz.sh status` | Cek status semua service |
| `./debz.sh term` | Jalankan CLI terminal |
| `./debz.sh help` | Bantuan |

---

## 🧩 Komponen

| Komponen | File | Port |
|---|---|---|
| WebUI | `index.php` (PHP built-in server) | **666** |
| Tool server | `backend.py` (Flask) | **999** |
| CLI terminal | `debz-term.py` (Rich + prompt_toolkit) | — |
| Browser daemon | `pw_daemon.mjs` (Playwright + Chromium) | **9222** |

---

## ⚙️ Cara Kerja Konfigurasi

Ada 2 file config:

| File | Isi | Cara atur |
|---|---|---|
| `.ai-providers.json` | Provider + API key + model (yang utama) | **WebUI Settings** (paling gampang) |
| `.ai-config.ini` | Token tool server, port, max token | Edit manual / WebUI |

- Saat clone pertama, kedua file **otomatis dibuat dari `.example`** oleh `./debz.sh`, jadi langsung jalan.
- **Jangan pernah commit `.ai-config.ini` & `.ai-providers.json`** — isinya API key asli. Dua file itu sudah masuk `.gitignore`, jadi aman.

---

## 🛑 Stop & Status

```bash
./debz.sh status   # cek semua service
./debz.sh stop     # matiin semua service
```

---

## 🧪 Requirement

- Linux (Alpine / Debian / Ubuntu / Fedora) — script auto-detect package manager
- PHP CLI 8+, Python 3.10+, Node 18+ (buat browser daemon), Chromium (opsional)
- Koneksi internet saat install pertama

---

## 🔒 Catatan Keamanan

- Tool server (`backend.py`) punya filter perintah berbahaya (`rm -rf /`, `dd`, `mkfs`, dll) — butuh approval eksplisit
- WebUI punya proteksi password + rate-limit login
- Ganti `AI_TOOLS_TOKEN` di `.ai-config.ini` sebelum dipakai di jaringan publik

---

## 🛠️ Troubleshooting

**WebUI kebuka tapi chat error "AI_API_KEY not configured"?**
→ Belum diisi API key. Ikuti langkah **Setup Pertama Kali** di atas.

**`debz-term: command not found`?**
→ Jalankan `./debz.sh` dulu (biar command kepasang ke PATH), atau pakai `./debz.sh term`.

**Tool server nggak start?**
→ Cek `logs/backend.log`. Biasanya karena `AI_TOOLS_TOKEN` kosong di `.ai-config.ini`.

**Browser daemon off?**
→ Itu normal kalau Node/Playwright nggak ada — fitur browser aja yang nonaktif, chat & tools tetap jalan.

---

Dibuat dengan ❤️ oleh **Debz** — platform agent MANDIRI.