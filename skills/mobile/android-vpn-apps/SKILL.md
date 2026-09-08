---
name: android-vpn-apps
description: "Build Android VPN/tunnel apps: OpenVPN3, SSH, VpnService."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn, vpnservice, ssh, tunnel, github-actions, kotlin, compose]
    category: mobile
---

# Android VPN / Tunnel App Development

## When to Use
Building or debugging Android apps that create VPN tunnels: OpenVPN clients (VPN Gate, OpenVPN3), SSH tunnel / "injector" apps (FastSSH-style), VpnService-based proxies. Covers engine integration, Android 14+ foreground-service rules, keep-alive/Doze, notification sync, and GitHub Actions CI builds. All lessons below were confirmed in production across ~60 build iterations of a real app.

## OpenVPN3 engine (`io.github.tim06:openvpn`)
Maven Central fork of ics-openvpn (Apache-2.0); bundles `libovpn3.so` for all 4 ABIs. Add `io.github.tim06:openvpn:1.1.3` and pin `io.github.tim06:basevpnprotocols:1.1.1`.

**Confirmed library bugs (bypass, don't fight them):**
1. `OpenVPNConfigParser.parse()` crashes with `fromIndex = -1` on configs lacking `<tls-crypt>` (all VPN Gate configs). Bypass: build `OpenVPNConfig` manually and set `configuration = rawConfigText` — engine uses `conf.configuration ?: conf.buildConfig()`.
2. `VpnServiceConnection.start(config, ...)` **never delivers config to the service** (parameter discarded; only binds + calls `startVPN()`). Deliver config via intent extra `CONFIGURATION_KEY` with `ACTION_START`, or run the engine in-process with your own VpnService.
3. Library `OpenVPNService` is `final` → fork its source (Apache-2.0) or run `OpenVPNThreadv3` in-process.
4. **MUST call `super.event(e)`** when overriding `event()` — the base implementation maps engine events → `updateStateThread()` → UI state. Skipping it leaves the UI stuck on "Connecting…" forever while the VPN is actually connected (classic symptom: app connected, status bar notif also stuck).
5. Release AAR silences all engine logs (`OpenVPNLogger` gated on `BuildConfig.DEBUG`). Subclass `OpenVPNThreadv3`, override `log()`/`event()`/`connect()` to capture logs into your own buffer → write to file.

## Cipher — the #1 OpenVPN3 connect blocker
OpenVPN3 core REJECTS `AES-128-CBC` for the data channel: `crypto_alg: AES-128-CBC: bad cipher for data channel use` → infinite reconnect loop. VPN Gate configs still ship CBC.
Fix: strip ALL `cipher`/`data-ciphers`/`keysize`/`connect-retry` lines (case-insensitive) from the raw config, then append:
```
cipher CHACHA20-POLY1305
data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
```
ChaCha20 first — many SoftEther servers have an AES-GCM bug: CONNECTED then `Session invalidated: DECRYPT_ERROR`.

## VPN Gate server semantics (free servers are a lottery)
- API: `https://www.vpngate.net/api/iphone/` — CSV; 15 columns; OpenVPN config = base64 in the LAST column; the Message field contains commas → always `split(",", limit = 15)`.
- `AUTH_FAILED` = server FULL, not missing credentials. Add `auth-user-pass` + override `provide_creds()` returning `vpn`/`vpn` for the rare auth-gated servers.
- `DECRYPT_ERROR` right after CONNECTED = broken server → fail fast, mark dead, move on.
- `KEEPALIVE_TIMEOUT` after minutes = server host offline (or client Doze-throttled — see keep-alive section).
- Many servers cap sessions at 30min–2h; DC is the server's choice, not an app bug.
- REQUIRED: aggressive auto-failover across the list (dead-server set, next-server on any failure), periodic list refresh, skip health-check-socket-tests while connected (they starve the tunnel's keepalive → self-inflicted KEEPALIVE_TIMEOUT).

## Android 14+ Foreground Service
`MissingForegroundServiceTypeException: Starting FGS without a type` on targetSdk 34+. Fix in manifest:
```xml
<service android:name=".vpn.XxxVpnService"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:exported="false"
    android:foregroundServiceType="specialUse">
  <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>
</service>
```
plus `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` permissions. Note: `vpn` is NOT a valid `foregroundServiceType` value — use `specialUse` + the property.

## Keep-alive / Doze (auto-DC after a few minutes)
Healthy connection drops with KEEPALIVE_TIMEOUT after minutes with screen off = Doze throttling. Fixes:
- Acquire `PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF` wifi lock while CONNECTED (release on disconnect/stop).
- Request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (system dialog) on first connect.
- Permissions: `WAKE_LOCK`, `ACCESS_WIFI_STATE`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

## VpnService.Builder routing
Do NOT hardcode `addAddress("10.111.0.2", 24)` / `addRoute("0.0.0.0", 0)` when the engine pushes its own addresses — conflicting addresses break routing → "connected but no internet" (bengong). Let the engine set addresses/routes/DNS via its callbacks. Only set session/mtu/blocking in the builder.

## Notification sync (foreground service)
- Update the FGS notification by RE-CALLING `startForeground(id, notif)` on the MAIN thread (`handler.post`), never `nm.notify()` from an engine thread (unreliable for FGS).
- Store timer Runnables and `removeCallbacks` them on every state change — otherwise a stale "Connected ⏱" timer flips the notification backwards while the app is Connecting.
- On disconnect: post a "Disconnected" notification first, delay ~800ms, then `stopForeground(STOP_FOREGROUND_REMOVE)` (FGS notifications with actions can linger on some devices).
- Show `flag + server IP` as the notification title, not the raw server name/id.

## Compose stale-closure pitfall
A `refresh()` that reads a `by remember { mutableStateOf(...) }` value captured at composition sees STALE state after connect. Read fresh inside the coroutine: `VpnController.state.value`. Also gate health checks on the fresh state — see VPN Gate section.

## CI / versioning (GitHub Actions)
- `versionCode` MUST increase every build or Android refuses the install and silently keeps the old APK ("always installs old version" symptom).
- GitHub Actions checkout is shallow → `git rev-list --count HEAD` always returns 1. Use `System.getenv("GITHUB_RUN_NUMBER")` for versionCode.
- Name artifacts with the version (`app-v${{ github.run_number }}`) so users stop downloading stale artifacts.
- Always uninstall the old APK before installing a new debug build.

## Debugging loop that worked
- LogSaver: capture every engine log + state change to `filesDir/logs/`; expose a "Share Logs" button (FileProvider + ACTION_SEND) so the user can send logs via Discord/WhatsApp.
- When app and notification-bar disagree, ask for screenshots of BOTH.
- Stamp version in the log header; per user convention, show the version only inside the DEV layer, never the main header.

## SSH tunnel apps (FastSSH-style)
See `references/fastssh-webview-account.md`.

## References
- `references/openvpn3-tim06-integration.md` — full API contract & confirmed library bugs
- `references/fastssh-webview-account.md` — FastSSH WebView account generation + JSch tunnel
