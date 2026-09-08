---
name: debz-ai-webui-ops
description: "Fix & operasi WebUI Debz AI (nginx + php-fpm). CSS/JS gak kebaca = mime.types belum di-include."
version: 1.0.0
tags: [nginx, php-fpm, mime-types, debz-ai, webui, termux]
---

# Debz AI WebUI Ops

## Gejala
WebUI tampil putih polos tanpa tema CSS.

## Root Cause
Config nginx gak include mime.types -> CSS/JS terkirim sebagai text/plain, browser nolak.

## Fix
1. Tambah "include \$PREFIX/etc/nginx/mime.types;" di blok http{} config nginx.
2. Pastikan debz.sh auto-regenerate config kalau stale (needs_regen).
3. Hard refresh browser (Ctrl+Shift+R).

## Cek Cepat
curl -sI http://127.0.0.1:8080/c0n73xt.css | grep Content-Type
# harus: text/css
