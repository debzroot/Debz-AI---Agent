---
name: android-vpn-app-development
description: "Build Android VPN apps with embedded OpenVPN3."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn, vpnservice, openvpn3, ics-openvpn, tim06, kotlin, compose]
    category: mobile
---

# Android VPN App Development (OpenVPN3 embedded)

## When to Use

Building or debugging an Android app that embeds an OpenVPN client engine (connect/disconnect, server list, auto-failover) — especially apps sourcing free servers from **VPN Gate** (vpngate.net). Covers the tim06 Maven fork of ics-openvpn (OpenVPN3 core via JNI), VpnService integration, GitHub Actions CI build, and the specific failure modes seen in production.

## Library Choice (verified)

- `de.blinkt:openvpn` (ics-openvpn original) is **NOT on Maven Central**; JitPack builds for 0.7.x are all broken (`Error`).
- Working fork on Maven Central: **`io.github.tim06:openvpn:1.1.3`** — ships `libovpn3.so` for all 4 ABIs, `OpenVPNService` with proper Android 14 `specialUse` FGS manifest, AIDL bind (`VpnServiceConnection`, `IVPNService`, `IConnectionStateListener`).
- Pin transitive deps: `io.github.tim06:basevpnprotocols:1.1.1` + implicit `io.github.tim06:vpnprotocolsnotification` (provides `com.tim.notification.*`).

## Core Architecture

1. **Own `VpnService`** (`android.net.VpnService`) declared in manifest; engine runs inside it via a **subclass of `com.tim.openvpn.OpenVPNThreadv3`** (NOT the library's own `OpenVPNService` — that one silently swallows errors, see pitfalls).
2. Implement `com.tim.openvpn.service.IOpenVPNService` (or a thin adapter) so the engine's tun-builder callbacks (`openTun`, `setLocalIP`, `addRoute`, `addDNS`, `protectFd`, …) write into your `VpnService.Builder`.
3. Start flow: `VpnService.prepare()` → permission launcher → `startForegroundService` → bind (LocalBinder) → `startVpn(config)` → `VpnController.runEngine(config, service)`.
4. UI observes state via a singleton `VpnController` with `StateFlow<ConnectionState>` + engine-log list; overlay shows Connecting/Connected/Failed with cancel.

See `references/tim06-openvpn3-library.md` for the exact API surface and `references/vpngate-free-servers.md` for the server source + config sanitization.

## CRITICAL Pitfalls (each cost hours)

1. **Release AAR swallows ALL engine logs.** `OpenVPNLogger`/`VpnStatus.log` gate on `BuildConfig.DEBUG`, and the Maven AAR is release (`DEBUG=false`). Every connect error is silent. Fix: subclass `OpenVPNThreadv3` and override `log(ClientAPI_LogInfo)`, `event(ClientAPI_Event)`, `connect()` to forward text/errors into your own controller. Add file logging (LogSaver) + a Share Logs button for on-device debugging.
2. **`event()` override MUST call `super.event(e)`.** The base implementation maps engine events (RESOLVE/WAIT/CONNECTING/GET_CONFIG/ASSIGN_IP/CONNECTED/DISCONNECTED) → `IOpenVPNService.updateStateThread()` → your state. Overriding without super leaves the UI stuck on "Connecting…" forever even though the tunnel is actually up. Same class of bug: any override that swallows the parent's side effect.
3. **`management` reference race.** Assign the `OpenVPNThreadv3` instance to the controller's field **before** starting its thread. If assigned inside the thread, `stopVPN()` called from the main thread (cancel button) sees `null` → cancel dead. Also: `Thread.interrupt()` does NOT stop native `connect()` — you must call `management.stopVPN()` first.
4. **Timeout loop must break on `CONNECTED`.** If the connect-timeout coroutine only polls `engineThread.isAlive`, it will murder a *healthy* connection at 20 s (the engine thread stays alive during a live session). Loop condition: `while (thread.isAlive && state != CONNECTED)`, and guard the timeout branch with `if (state != CONNECTED)`.
5. **OpenVPN3 core rejects `AES-128-CBC`** for the data channel (`bad cipher for data channel use` → infinite reconnect loop). VPN Gate configs still ship CBC. Strip ALL `cipher`/`data-ciphers`/`keysize` lines (case-insensitive line filter, not regex replace) and inject `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`. Prefer ChaCha20 first: some SoftEther servers have an AES-GCM bug (`DECRYPT_ERROR`).
6. **`DECRYPT_ERROR` / `Session invalidated` = broken server → stop engine immediately**, not just report. Otherwise the core's internal auto-restart loops reconnect to the same dead server forever and failover never triggers (state never leaves CONNECTING). Failover must also re-check `userCancelled` after its delay.
7. **Never hardcode `addAddress`/`addRoute` in the `VpnService.Builder`** — the engine pushes real addresses from the server and the two conflict → "Connected" but zero internet (routing chaos). Let the engine callbacks populate the builder exclusively. Also add `block-ipv6` to the config: Android hangs trying IPv6 on servers that don't push it.
8. **Android 14+ FGS type:** service needs `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission, else `MissingForegroundServiceTypeException` crash at `startForeground`. Note `vpn` is NOT a valid FGS type value — AAPT rejects it; `specialUse` is correct.
9. **versionCode MUST increase every build** or Android silently keeps the old APK ("always installs the old version" mystery). Derive from `git rev-list --count HEAD` in `build.gradle.kts` and name CI artifacts with the version (`debnetplus-v0.1.${{ github.run_number }}`). **In GitHub Actions use `System.getenv("GITHUB_RUN_NUMBER")` instead of git count — Actions checkout is shallow (depth 1) so `rev-list --count` ALWAYS returns 1**, making every build look like version 1 and Android refuse upgrades. Put the version in the UI header / log first line so the user can verify which build is installed.
10. **AGP 8.5.2 caps at compileSdk 34**; needs `buildFeatures { buildConfig = true }` for `BuildConfig.VERSION_NAME` (off by default in AGP 8+).
11. **FGS notification sync** (apk says Connected but status bar says Connecting, or reversed): update the FGS notification by calling `startForeground(id, notif)` AGAIN — and only from the MAIN thread (`handler.post`). `nm.notify()` from the engine thread does NOT reliably update FGS notifications. Store the ⏱ timer `Runnable` and `removeCallbacks` it on every state change — stale callbacks flip the notif to an old state. On disconnect, post "Disconnected" first, delay ~800 ms, then `stopForeground(STOP_FOREGROUND_REMOVE)` (FGS notifs with action buttons otherwise stick as "Connected"). Title: `🌍 <ip>` (flag + host IP) instead of raw server IDs. See `references/android-fgs-notification-wakelock.md`.
12. **Doze mode auto-DCs a healthy tunnel after a few minutes** (`Session invalidated: KEEPALIVE_TIMEOUT` even though user didn't disconnect). Fix: hold a `PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF` wifi lock while CONNECTED, release on disconnect; also request battery-optimization exemption (`Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) on first connect — mainstream VPN apps all do this. Without it Android throttles the process when the screen is off and keepalive pings never leave.
13. **Stale-closure trap in refresh loops:** a `refresh()` defined inside a Composable captures `vpnState` from COMPOSITION time — it keeps running with old values after connect. Read `VpnController.state.value` fresh at execution time, and SKIP the whole refresh (no list clear, no fetch, no health check) while CONNECTED/CONNECTING. Health-check socket tests (66+ TCP connects) run through the live tunnel hammer it → KEEPALIVE_TIMEOUT auto-DC around 20 min.
14. **tim06 library bugs that force the integration pattern:** `VpnServiceConnection.start(config)` silently DROPS the config (never delivered to the service) — start via explicit Intent with `CONFIGURATION_KEY` extra instead. `OpenVPNConfigParser.parse()` crashes `fromIndex = -1` on VPN Gate configs (searches for a `<tls-crypt>` block that doesn't exist) — build `OpenVPNConfig` manually and set the `configuration` field to the raw config text (service uses `conf.configuration ?: conf.buildConfig()`).

## CI (GitHub Actions)

`ubuntu-latest` + `actions/setup-java@v4` (temurin 17) + `gradle/actions/setup-gradle@v4` + `./gradlew assembleDebug` + `upload-artifact@v4`. JitPack-style `gradle-wrapper.jar` can be pulled from the gradle repo tag. Full recipe + gotchas: `references/github-actions-android.md`.

## UI / UX lessons

- Connect overlay must offer a cancel path in EVERY state (connecting AND failed) — a "Stop Failover" button; overlay stuck is the #1 complaint.
- Auto-failover (skip dead servers, move to next, 1.5 s pause) is expected behavior for free VPN sources; also auto-refresh the server list every ~5 min.
- Stream-parse the server CSV line-by-line into chunks so the list populates progressively (perceived speed), and cache raw text to disk for instant first paint.
- Notification should carry a Disconnect action + connection-duration timer; title shows flag+IP (`🌍 114.185.85.134`), never the raw server ID (`vpn556327500`).

## Support files
- `references/tim06-openvpn3-library.md` — exact API surface + library quirks (config-drop in VpnServiceConnection, ConfigParser `<tls-crypt>` crash)
- `references/vpngate-free-servers.md` — server source + config sanitization (cipher strip, block-ipv6)
- `references/github-actions-android.md` — CI recipe + versioning gotchas
- `references/android-fgs-notification-wakelock.md` — FGS notification sync, disconnect sequence, Doze/wakelock, battery exemption, stale-closure refresh
- `references/android-vpn-ui-style.md` — user's hacker/terminal design tokens (neon green #39FF14, glassmorphism, Saira/JetBrains Mono, glitch banner, terminal log) — apply to next VPN app builds
