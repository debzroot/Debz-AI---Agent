---
name: android-openvpn-client
description: "Build/debug Android OpenVPN apps: engine, VPN Gate, CI."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, openvpn, vpn, kotlin, compose, github-actions, vpngate]
    category: software-development
---

# Android OpenVPN Client (OpenVPN3 integration)

Build & debug Android apps that embed OpenVPN (ics-openvpn-style), fetch configs from VPN Gate, and build APKs via GitHub Actions. Learned building DebNet+ (Kotlin + Compose + `io.github.tim06:openvpn` engine).

## When to use

- User wants an Android VPN app: generate config, connect, disconnect, failover
- Debugging "connected but no internet", "stuck connecting", notification desync, or auto-DC after minutes
- Building APKs in GitHub Actions (no local Android SDK)

## Core architecture (tim06 OpenVPN3 engine)

- Dependency: `io.github.tim06:openvpn:1.1.3` + `io.github.tim06:basevpnprotocols:1.1.1` (Maven Central)
- Engine class: `com.tim.openvpn.OpenVPNThreadv3(IOpenVPNService, configString)` — NOT final, subclass it
- Service: use your OWN `android.net.VpnService` (NOT `com.tim.openvpn.service.OpenVPNService` — that one is built for a multi-process AIDL setup and its `VpnServiceConnection.start()` DROPS the config, plus release AAR swallows all logs via `BuildConfig.DEBUG=false`)
- Set `management` BEFORE starting the engine thread, or `stopEngine()` can't reach it (race condition → cancel button dead)

## The 5 critical pitfalls (each cost hours)

1. **`cipher` must be REPLACED, not appended.** VPN Gate configs ship `cipher AES-128-CBC`; OpenVPN3 core rejects CBC for the data channel (`bad cipher for data channel use` → infinite reconnect loop). Strip ALL cipher/data-ciphers/keysize lines (case-insensitive), then add `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`. ChaCha20 first: many SoftEther servers have AES-GCM DECRYPT_ERROR bugs.
2. **Never hardcode fake addresses/routes in `VpnService.Builder`.** If you add `addAddress("10.111.0.2", 24)` AND the engine pushes real IPs, they conflict → "connected but no internet" (traffic goes nowhere). Let the engine's callbacks set everything from the server push.
3. **Call `super.event(e)` when overriding `event()`.** The parent maps CONNECTED/DISCONNECTED → `updateStateThread` → UI. Skipping it = UI stuck on "Connecting…" forever while engine is actually connected.
4. **Foreground notification updates: use `startForeground(NOTIF_ID, notif)` on the MAIN thread** (Handler.post), not `nm.notify()` from the engine thread. Cancel stale timer callbacks (for ⏱ duration ticks) when state changes, or a stale "Connected" tick flips the notification backwards.
5. **Auto-DC after minutes = Doze mode.** Acquire a PARTIAL_WAKE_LOCK + WIFI_MODE_FULL_HIGH_PERF wifi lock while connected, release on disconnect; request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` via `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` on first connect. Without these, keepalive pings stall → `KEEPALIVE_TIMEOUT` → dc.

## VPN Gate specifics

- API: `https://www.vpngate.net/api/iphone/` — CSV, 15 cols, config base64 is col 14 (last). Header starts `#`, footer `*`. Split with limit=15 (message field can contain commas).
- `AUTH_FAILED` ≠ bad credentials → server is FULL (max users). It's the standard SoftEther error for full slots.
- Many servers are broken: `DECRYPT_ERROR` (SoftEther GCM bug) and `KEEPALIVE_TIMEOUT` (host offline). Auto-failover is mandatory: on failure, mark server dead, try next; re-check `userCancelled` AFTER any delay.
- Some servers want creds: add `auth-user-pass` + override `provide_creds()` to send `vpn`/`vpn` (public standard).
- Health check: TCP connect to host:port with 1.2s timeout; skip health check while connecting/connected (socket tests through the tunnel cause lag).

## GitHub Actions APK build

- Debug APK: `assembleDebug` — no signing needed. Upload via `actions/upload-artifact@v4`.
- **versionCode must increase every build** or Android refuses install (silently keeps old app). GitHub checkout is SHALLOW (depth 1), so `git rev-list --count HEAD` always returns 1 — use `System.getenv("GITHUB_RUN_NUMBER")` instead.
- Name artifacts with the version: `debnetplus-v0.1.${{ github.run_number }}` so users don't grab a stale artifact.
- AGP 8.5.2 max tested compileSdk = 34; `foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn` required for Android 14+ FGS (else `MissingForegroundServiceTypeException`).

## Debugging workflow that worked

1. Ship file-based logging (LogSaver → `filesDir/logs/`), share via FileProvider; version-stamp the first line.
2. User sends log → grep for `STATE:`, `EVT`, `Session invalidated: <REASON>`, `TIMEOUT`.
3. Distinguish server-side vs app-side: `DECRYPT_ERROR`/`KEEPALIVE_TIMEOUT`/`AUTH_FAILED` after `EVT CONNECTED` = server issue; app should fail fast and move on.
4. When the engine loops on the same broken server, STOP the engine on `Session invalidated` (fail-fast) so the app-level failover can switch servers.

See `references/tim06-openvpn-engine.md` for full API surface (IOpenVPNService contract, ClientAPI classes, service quirks).
See `templates/vpngate-config-builder.kt` for the known-good config sanitizer (strip CBC, force CHACHA20/GCM, block-ipv6, auth-user-pass).
