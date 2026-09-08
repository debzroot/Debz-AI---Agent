---
name: android-vpn-development
description: "Build Android VPN/APK apps: OpenVPN3, VpnService, CI."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn, apk, vpnservice, github-actions, kotlin, jetpack-compose]
    category: software-development
---

# Android VPN App Development

## When to Use

Building or debugging an Android VPN/APK app: OpenVPN client with embedded engine, VpnService implementation, fetching configs from free VPN sources (VPN Gate), or CI-building APKs on GitHub Actions. Covers the whole class: architecture, engine quirks, Android platform requirements, server-pool reality, and build pipeline.

## Working Architecture (proven pattern)

```
app process (no :openvpn separate process needed)
├─ MainActivity          → VpnService.prepare() → permission flow → bind service
├─ DebOpenVpnService     → extends VpnService, implements EngineCallback + IOpenVPNService
├─ VpnController (obj)   → StateFlow(state/lastError/engineLogs/config) → Compose UI
│   └─ runEngine()       → builds OpenVPNThreadv3 subclass in a Thread
└─ UI (Jetpack Compose)  → collectAsState on VpnController flows
```

- Engine runs **in the app process** via a plain `Thread` (no AIDL/service-split needed) so exceptions/logs are visible instead of being swallowed.
- `IOpenVPNService` stub in `VpnController` delegates to the service's `EngineCallback`; `OpenVPNThreadv3` subclass overrides `log()`/`event()`/`connect()`/`provide_creds()` for observability.
- Start service via `startForegroundService` + bind with a `LocalBinder` (inner class extending `Binder`) so the Activity gets the instance directly. **Do NOT use reflection to grab the service.**

## Critical Pitfalls (each cost hours — read before writing code)

1. **OpenVPN3 rejects CBC ciphers.** Configs with `cipher AES-128-CBC` (VPN Gate defaults) die with `crypto_alg: AES-128-CBC: bad cipher for data channel use` → reconnect loop. Fix: **strip all** `cipher`/`data-ciphers`/`keysize`/`connect-retry` lines (filter lines, case-insensitive) and append `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`. ChaCha20 first — several SoftEther servers have AES-GCM `DECRYPT_ERROR` bugs.
2. **`super.event()` is mandatory** in your `event()` override — it's what maps EVT names → `ConnectionState` → UI. Override without calling super = engine connects but UI stuck on "Connecting…" forever.
3. **Set the engine ref BEFORE thread start.** `management = thread` must happen before `Thread{...}.start()`, otherwise `stopEngine()` (cancel button) races with a null ref and does nothing → user stuck in overlay.
4. **Android 14+ FGS**: `foregroundServiceType="vpn"` is NOT a valid FGS type (AAPT rejects it). Use `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission. Missing type entirely = `MissingForegroundServiceTypeException` crash on connect.
5. **Don't hardcode address/routes/DNS in `Builder()`** — the engine adds the real pushed IP/routes/DNS via callbacks. A fake `addAddress("10.111.0.2", 24)` conflicts with the pushed net30 address → "Connected" but zero internet.
6. **Doze mode kills keepalive → auto-DC after minutes.** `KEEPALIVE_TIMEOUT` after a few minutes with screen off = app not holding locks. Acquire `PARTIAL_WAKE_LOCK` + WiFi lock (`WIFI_MODE_FULL_HIGH_PERF`) when state→CONNECTED, release on disconnect. Also request `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` on first connect (standard VPN-app UX).
7. **Notification sync**: updating a foreground-service notification via `NotificationManager.notify()` from the engine thread silently fails on many devices. Update via **`startForeground(NOTIF_ID, newNotif)` posted on the main thread (Handler)**.
8. **`versionCode` must increment every build** or Android keeps the old APK. GitHub Actions checkout is shallow → `git rev-list --count` returns 1. Use `System.getenv("GITHUB_RUN_NUMBER")` for both versionCode and artifact naming.
9. **AGP 8+ hides BuildConfig** — add `buildConfig = true` to `buildFeatures` or `BuildConfig.VERSION_NAME` is unresolvable.
10. **Free server pools (VPN Gate) are a lottery**: `AUTH_FAILED` = server FULL (not bad credentials — don't misread it); `DECRYPT_ERROR` after CONNECTED = broken SoftEther server; `KEEPALIVE_TIMEOUT` = server died. Ship: TCP health-check prefilter (`Socket.connect` 1.2s timeout), refresh that RESETS the list (dead servers vanish), and an auto-failover loop that marks failed servers dead and moves on.

## Reference Files

- `references/openvpn3-tim06-integration.md` — tim06 `io.github.tim06:openvpn` library API quirks (VpnServiceConnection bug, parser crash, provide_creds, state mapping).
- `references/vpngate-server-pool.md` — VPN Gate API format, server failure taxonomy, health-check + failover strategy.
- `references/github-actions-apk-ci.md` — APK CI workflow: versioning, artifacts, workflow YAML.

## Build Loop

Code → push to `main` → GitHub Actions `assembleDebug` → download artifact → uninstall old APK (same-versionCode installs are silently rejected) → test → read `LogSaver` file (share via DEV screen) for real engine output. Add file-based logging (`LogSaver`) early — engine logs are the only way to debug OpenVPN3 issues; the AAR ships release-build with `OpenVPNLogger` disabled.
