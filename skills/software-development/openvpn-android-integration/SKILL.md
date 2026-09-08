---
name: openvpn-android-integration
description: "Build Android OpenVPN clients (OpenVPN3, VPN Gate, CI)."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, openvpn, vpngate, kotlin, vpn, github-actions]
    category: software-development
---

# OpenVPN Android Integration

## When to Use
- Building or modifying an Android VPN client app that embeds OpenVPN (ics-openvpn forks / OpenVPN3 core, e.g. `io.github.tim06:openvpn`).
- Connecting to **VPN Gate** free servers from Android.
- Debugging "stuck Connecting", "connected but no internet", AUTH_FAILED, cipher errors, or Cancel/Disconnect not working in an OpenVPN3-based app.
- Setting up GitHub Actions CI to build APK artifacts.

## Architecture (tim06 fork, Maven Central)
- Artifacts: `io.github.tim06:openvpn:1.1.3` (+ `basevpnprotocols:1.1.1` — pin it; `vpnprotocolsnotification` comes transitively).
- `OpenVPNThreadv3(IOpenVPNService, configString)` is the engine wrapper — **subclassable** (not final). `ClientAPI_OpenVPNClient` constructor is protected (can't instantiate directly).
- The library's `OpenVPNService` runs in a separate `:openvpn` process; simpler to run the engine in your own `VpnService` in the main process via `OpenVPNThreadv3`.
- **The release AAR silences ALL engine logs** (`BuildConfig.DEBUG=false`). To see what's happening, override `log()`/`event()`/`connect()` on your `OpenVPNThreadv3` subclass and forward to your own logger.

## Critical Pitfalls (each cost hours in the field)
1. **`VpnServiceConnection.start(config)` DISCARDS the config** — library bug. The config only reaches the service via an intent extra (`CONFIGURATION_KEY`). Bind the service only for state callbacks; start it with an intent carrying the config.
2. **`OpenVPNConfigParser.parse()` crashes on VPN Gate configs** — it searches for a `<tls-crypt>` block that VPN Gate configs lack → `subList(-1, 0)` → "fromIndex = -1". Construct `OpenVPNConfig` manually and set `configuration = rawConfig`; the service uses `conf.configuration ?: conf.buildConfig()`.
3. **Overriding `event()` WITHOUT calling `super.event(e)` = UI stuck "Connecting…" forever.** `super.event()` is what maps engine events → `updateStateThread` → UI state. Always call super after your logging.
4. **Cipher: VPN Gate configs use deprecated `cipher AES-128-CBC`; OpenVPN3 core REJECTS CBC** ("bad cipher for data channel use") → infinite reconnect loop. STRIP every `cipher`/`data-ciphers`/`keysize` line from the config, then inject `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`. Put ChaCha20 first — SoftEther has an AES-GCM bug that throws `DECRYPT_ERROR`.
5. **Timeout watchdog must stop once state == CONNECTED** — the engine thread stays alive during a live session, so `while (thread.isAlive)` alone kills healthy connections at timeout. Guard with `_state.value != CONNECTED`.
6. **`stopEngine()` must call `management.stopVPN()` BEFORE `thread.interrupt()`** — native `connect()` ignores interrupts. Assign the `management` reference BEFORE the thread starts (race condition otherwise).
7. **Never hardcode a fake address/route in `VpnService.Builder`** (e.g. `addAddress("10.111.0.2", 24)`) — it conflicts with the pushed server IP → "connected but no internet". Let the engine set addresses/routes/DNS via callbacks.
8. **Add `block-ipv6` to the config** — most VPN Gate servers don't push IPv6 correctly; Android hangs resolving IPv6 → "connected but bengong".
9. **Android 14+ foreground service**: `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission. `foregroundServiceType="vpn"` is INVALID (AAPT rejects it). Missing the type → `MissingForegroundServiceTypeException` crash on `startForeground`.
10. **AGP 8.5.2 → max compileSdk 34**; compileSdk 35 breaks AAPT. Also enable `buildConfig = true` in `buildFeatures` for AGP 8+ if you reference `BuildConfig`.
11. **Notification sync**: update the notification inside `onStateChanged` (Connected/Connecting/Disconnected), not just at start — otherwise the shade stays "Connecting" while the app shows Connected.

## VPN Gate (vpngate.net)
- API: `https://www.vpngate.net/api/iphone/` → CSV: header row starts `#`, footer `*`, 15 columns, **OpenVPN config base64 is the LAST column** (split with `limit=15`; the message field can contain commas).
- Health check before connect: plain TCP connect to `ip:port` with ~1.2s timeout; filter dead hosts out of the list.
- Server-state semantics: `AUTH_FAILED` = server FULL (not bad creds), `DECRYPT_ERROR` = broken server (GCM bug), `KEEPALIVE_TIMEOUT` = server died mid-session, `Connection refused` = down.
- Free servers drop sessions constantly → **auto-failover to the next server is mandatory** for a usable app. On any terminal failure: mark host dead, stop engine, try next.
- Some servers ask for auth → override `provide_creds()` to send `vpn`/`vpn` and add `auth-user-pass` to the config.

## CI Build (GitHub Actions)
- **versionCode MUST increment every build** or Android refuses install (keeps the old APK silently). Use `GITHUB_RUN_NUMBER` — Actions checkout is shallow (depth 1), so `git rev-list --count HEAD` always returns 1.
- Name the artifact with the version (e.g. `debnetplus-v0.1.${{ github.run_number }}`) so users don't download stale builds.
- Standard flow: checkout → setup-java 17 → gradle/actions setup → `./gradlew assembleDebug` → upload-artifact.

## References
- `references/tim06-library-quirks.md` — decompiled API surface, exact bug evidence, debugging transcript.
- `references/vpngate-config-fixes.md` — config transformation recipe and server behavior notes.
