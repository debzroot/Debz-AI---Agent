---
name: android-vpn-tunnel-apps
description: "Android VPN/tunnel clients: OpenVPN3, SSH/SOCKS."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn, ssh, tunnel, socks, vpngate, kotlin, compose, github-actions]
    category: mobile
---

# Android VPN & Tunnel Client Apps

## When to Use

- User wants an Android app that connects to OpenVPN servers (VPN Gate, free .ovpn sources) or builds an SSH/SOCKS tunnel client (HTTP Injector / KPN Tunnel style).
- Embedding a third-party VPN engine library (OpenVPN3 AAR, JSch, Dropbear) into a Kotlin/Compose app.
- Debugging "connected but no internet", "DC after N minutes", "notification out of sync", or "install keeps the old version" in a VPN app.
- Building an APK pipeline on GitHub Actions for such an app.

Use when building Android apps that establish VPN/tunnel connections — OpenVPN clients (VPN Gate, free configs), SSH tunnel clients (HTTP Injector / KPN Tunnel style), or integrating a third-party VPN engine library.

## Two architecture flavors

1. **OpenVPN3 engine** (DebNet+ style): embed `de.blinkt`-family OpenVPN3 AAR (e.g. `io.github.tim06:openvpn` + `basevpnprotocols` + `vpnprotocolsnotification` on Maven Central), drive `OpenVPNThreadv3` with an `IOpenVPNService`-style callback impl, build your own `VpnService`.
2. **SSH tunnel** (DebSSH+ style): JSch (or Dropbear native) SSH session → dynamic port forwarding → SOCKS5 proxy → VpnService tun + a tun2socks-style forwarder. Optionally WebView-based account generation from a provider page (FastSSH).

## Build pipeline (GitHub Actions) — DO THIS FIRST

- **`versionCode` MUST auto-increment or Android silently refuses installs** (keeps old version). Use `System.getenv("GITHUB_RUN_NUMBER")` — NOT `git rev-list --count HEAD` (Actions checkout is shallow → always 1).
- Name artifacts with the version: `debnetplus-v0.1.${{ github.run_number }}` so users stop downloading stale builds.
- Add `buildConfig = true` to `buildFeatures` or `BuildConfig` won't exist (AGP 8+).
- JDK 17 + `gradle/actions/setup-gradle@v4` + `./gradlew assembleDebug --no-daemon` is a reliable base.

## Critical pitfalls (each one cost a debugging cycle)

1. **Android 14+ MissingForegroundServiceTypeException**: service MUST declare `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission. `vpn` is NOT a valid FGS type string — use `specialUse` + the subtype property.
2. **OpenVPN3 `super.event()` MUST be called** in your `ClientAPI_OpenVPNClient`/`OpenVPNThreadv3` override — the base class maps EVT names to `ConnectionState` → UI. Overriding without calling super = UI stuck "Connecting…" forever even though the tunnel is up.
3. **Timeout loops must break on CONNECTED**: a `withTimeout(20s) { while (thread.isAlive) }` kills healthy sessions because the engine thread stays alive while connected. Guard: `while (isAlive && state != CONNECTED)` and re-check state in the catch.
4. **Wakelock + battery exemption = connection longevity**: acquire `PARTIAL_WAKE_LOCK` from service start (not after CONNECTED), request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` on first connect. Without these, Doze throttles the app → keepalive pings drop → server kills session (KEEPALIVE_TIMEOUT) minutes later.
5. **SSH keepalive**: JSch `setServerAliveInterval(30000)` + `setServerAliveCountMax(5)`.
6. **Notification sync**: update FGS notification via `startForeground(id, notif)` on the MAIN thread (Handler.post), not `NotificationManager.notify()` from the engine thread. Cancel stale timer callbacks when state changes or notif flips back to an old state.
7. **Compose stale-closure bug**: inside `rememberCoroutineScope().launch`, read `StateFlow.value` FRESH at execution time — a `vpnState` captured from composition is stale and re-runs work (e.g. health-check hammering the VPN tunnel every 5 min → KEEPALIVE_TIMEOUT → DC).
8. **Don't hardcode VPN addresses/routes in the VpnService Builder** — engine pushes real IPs via callbacks; a fake `addAddress("10.111.0.2",24)` conflicts → "connected but no internet".
9. **`block-ipv6` in OpenVPN config** prevents IPv6 lookup hangs on servers that don't push v6 properly.
10. **Kotlin interface impl mismatches**: library Kotlin interfaces use nullable types (`String?`) and Kotlin properties (`val connectivityManager`) — `javap -s` the AAR classes to get exact signatures before writing overrides. Overriding two interfaces with same-named methods = "Conflicting overloads" — drop one interface.
11. **Detect-and-stop, not detect-and-report**: when engine logs show `Session invalidated: DECRYPT_ERROR` / `KEEPALIVE_TIMEOUT`, STOP the engine (via `stopVPN()`) so auto-failover moves to the next server — otherwise the core loops reconnecting to the same broken server forever.
12. **WebView account auto-detect is fragile — default to manual-copy UX**: JS-injection success-detection on provider form pages (FastSSH) false-fires on template text and feels unstable (ghost-touch, "always backs out before account made") even with strict guards. The pattern that stuck: plain WebView (no JS bridge) + **Minimize/Close toolbar** (session stays alive while minimized) + app-side terminal input fields for Username/Password/Host/Port + separate `Buat Akun` and `Konek` buttons. Only attempt JS auto-detect on a confirmed-stable page. Full detail in `references/webview-account-automation.md`.

## VPN Gate specifics (free OpenVPN source)

- API: `https://www.vpngate.net/api/iphone/` — CSV; header row starts `#`, footer `*`, 15 cols, config is base64 in col 14. Stream line-by-line (OkHttp `source().readUtf8Line()`) to show servers incrementally.
- `AUTH_FAILED` = server is FULL (max users), NOT a credential problem — wrong to read it as "needs login".
- `DECRYPT_ERROR` = broken server (SoftEther data-channel bug). `KEEPALIVE_TIMEOUT` = server died/offline.
- Servers only accept TCP (many reject UDP); prefer `CHACHA20-POLY1305`, strip old `cipher`/`data-ciphers`/`keysize` lines entirely then append modern ones — OpenVPN3 rejects `AES-128-CBC` data channel.
- `Creds: UsernameEmpty/PasswordEmpty` → override `provide_creds()` to send `vpn`/`vpn` (public gate credential).
- Auto-failover loop (try next server on failure, skip dead ones) is mandatory — free pool is mostly full/broken.

## Debugging loop that worked

- Ship a `LogSaver` that appends every engine/state log line to `filesDir/logs/debnet_<ts>.log`, expose a **"Share Logs"** button via FileProvider (`androidx.core.content.FileProvider` + `res/xml/file_paths.xml`), and have the user send the file — never rely on screenshots or in-app-only logs. This made every root cause identifiable in one round-trip.
- Grep the log for `STATE:` transitions — they reveal whether UI state mapping is broken vs. engine actually failing.
- Verify which build is installed: show `BuildConfig.VERSION_NAME` in the UI subtitle or DEV screen; stamp it in the log header line.

## User preference (Debz)

- UI language: **Indonesian**; terminal-hacker aesthetic (neon green `#39FF14`, glassmorphism cards, glitch banner header, monospace logs); version shown ONLY in DEV layer (never header); "Logs"/"Share Logs" button lives in DEV screen.
- Account creation: prefers **manual control over automation** — when auto-detect misbehaves, don't keep tuning it; switch to manual copy (WebView minimize/close + paste into app fields). He'd rather paste four values than fight an unstable WebView.
- When a UI element he flags as wrong (overlapping text, off-center wrapper, weird server name in notification), fix layout/display precisely rather than leaving it "good enough".

## Support files

- `references/vpn-gate-openvpn3.md` — VPN Gate API format, error-code meanings, OpenVPN3 cipher saga, engine callback contract.
- `references/ssh-tunnel-stack.md` — JSch + SOCKS5 + pure-Java tun2socks forwarder, keepalive, wakelock timing.
- `references/webview-account-automation.md` — WebView + JS-injection account generation (FastSSH), success-detection pitfalls, deep-linking.
- `references/android-vpn-service-pitfalls.md` — FGS types, notification sync, Compose stale closures, build pipeline versioning.
