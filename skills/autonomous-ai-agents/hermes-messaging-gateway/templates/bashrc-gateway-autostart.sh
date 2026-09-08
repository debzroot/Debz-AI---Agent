#!/bin/bash
# Hermes Gateway autostart block — drop into ~/.bashrc (or the equivalent
# chroot rootfs copy) inside the existing "AUTO START SERVICES" guard block,
# right after the last service's closing `fi`. Idempotent: no double-start.
#
# Notes:
# - Absolute hermes path so it works regardless of login PATH.
# - (cd ~/.hermes && nohup ... &) keeps the process out of the login shell's
#   job table and logs to ~/.hermes/logs/gateway.log.
# - The nohup/'&' ban in the gateway skill applies ONLY to Hermes' own
#   terminal tool; this runs in the user's login shell, outside Hermes'
#   process tree, so nohup is correct here.
# - If this file itself is ever run via Hermes' terminal tool while the
#   gateway is live, the guard will refuse it (string match) — see SKILL.md
#   pitfall for the munge workaround.

echo "[+] Starting Hermes Gateway (Discord DM)..."
if ! pgrep -f "hermes gateway run" > /dev/null; then
    sleep 3
    mkdir -p ~/.hermes/logs
    (cd ~/.hermes && nohup /root/.local/bin/hermes gateway run > ~/.hermes/logs/gateway.log 2>&1 &)
    echo " Hermes Gateway Enabled"
else
    echo " Hermes Gateway already running"
fi
