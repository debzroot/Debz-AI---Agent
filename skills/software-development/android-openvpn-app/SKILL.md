---
name: android-openvpn-app
description: "Build Android OpenVPN client apps and their APK CI pipeline."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, openvpn, vpn, apk, kotlin, compose, github-actions, vpngate]
    category: software-development
---

# Android OpenVPN Client Apps

## When to Use

Building or debugging an Android app that connects to OpenVPN servers — VPN Gate random-server clients, "generate & connect" OVPN apps, anything embedding an OpenVPN engine in an APK. Also covers the GitHub Actions pipeline that builds such APKs.

## Library Selection (critical, learned the hard way)

- **`de.blinkt:openvpn` (ics-openvpn) is NOT on Maven Central** (404) and **JitPack builds are broken for 0.7.x** (`io.github.schwabe:ics-openvpn` returns Error on JitPack).
- **Use `io.github.tim06:openvpn` on Maven Central** — a fork of ics-openvpn with the OpenVPN 3 core (`libovpn3.so` native libs for all 4 ABIs, Apache-2.0). Transitive deps: `io.github.tim06:basevpnprotocols` and `io.github.tim06:vpnprotocolsnotification`. Pin the basevpnprotocols version whose API you verified.
- The engine class is `com.tim.openvpn.OpenVPNThreadv3` (subclass of SWIG `ClientAPI_OpenVPNClient`) — constructor `(IOpenVPNService, String config)` is public, class is NOT final, so you can subclass to intercept `log()`/`event()`/`connect()`.
- The AAR is a RELEASE build → `OpenVPNLogger` (gated on `BuildConfig.DEBUG`) is silent. Capture engine output yourself via `log()` overrides, or you will debug blind.

## Architecture That Works

```
MainActivity (VpnService.prepare() flow)
  └─ DebVpnService : VpnService, EngineCallback     ← your own service, SAME process
       └─ VpnController.runEngine(config, service)  ← runs OpenVPNThreadv3 on a thread
            └─ OpenVPNThreadv3(IOpenVPNService stub, config)
```

- Engine runs in the app process (not `:openvpn` split process) so exceptions/logs surface to the UI. A separate-process service (the library's own `OpenVPNService`) silences errors and makes cancel/disconnect impossible to observe.
- `VpnService.Builder` must NOT pre-add addresses/routes/DNS — the engine adds the real pushed IP via `tun_builder_*` → `IOpenVPNService` callbacks. A hardcoded `addAddress("10.111.0.2", 24)` **conflicts with the pushed IP → "connected but no internet"** (routing broken). Builder only: `setSession`, `setMtu`, `setBlocking`.
- Start the VPN flow: `VpnService.prepare()` via `ActivityResultContracts.StartActivityForResult`, then `startForegroundService` + `bindService` (LocalBinder pattern) so the Activity holds the service instance.

## Pitfalls (each one cost real debugging time — see references/openvpn3-pitfalls.md for transcripts)

1. **`VpnServiceConnection.start(config)` DROPS the config** (library bug — param never sent to service). Config only reaches the engine via intent extra (`CONFIGURATION_KEY` with `OpenVPNConfig` parcelable) on the `ACTION_START` path, or by passing raw config string directly into `OpenVPNThreadv3`.
2. **`OpenVPNConfigParser.parse()` crashes with `fromIndex = -1`** on VPN Gate configs (looks for `<tls-crypt>` block that doesn't exist). Bypass: build `OpenVPNConfig` manually and set its `configuration` field to the raw config text — the engine uses `conf.configuration ?: conf.buildConfig()`.
3. **OpenVPN3 core REJECTS AES-128-CBC for the data channel** (`crypto_alg: AES-128-CBC: bad cipher for data channel use` → infinite reconnect loop). STRIP every `cipher`/`data-ciphers`/`keysize`/`connect-retry` line from the config (case-insensitive), then append `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`. ChaCha20 first: many SoftEther/VPN Gate servers have an AES-GCM bug producing `Session invalidated: DECRYPT_ERROR` right after `EVT CONNECTED`.
4. **MUST call `super.event(e)` in your `event()` override.** The base class maps engine events (CONNECTED/DISCONNECTED/CONNECTING) to `IOpenVPNService.updateStateThread` → your state flow. Skipping it = engine connects fine but UI stuck on "Connecting…" forever, cancel dead, failover never triggers.
5. **`DECRYPT_ERROR` / "Session invalidated" = broken server** — report AND `stopEngine()` immediately (count ≤2). The OpenVPN core auto-reconnect loops on the SAME broken server; `connect-retry-max 1` does NOT stop this case. Only stopping the engine lets your app-level failover move on.
6. **Connect timeout loop must check `state != CONNECTED`**, not just `thread.isAlive` — the engine thread stays alive the whole session, so a pure-isAlive timeout kills a HEALTHY connection at 20s.
7. **Cancel requires `management.stopVPN()` before `thread.interrupt()`** — interrupt alone can't stop native `connect()`. Also set `management` BEFORE starting the thread (race: stopEngine from main thread saw null).
8. **Android 14+ (targetSdk 34):** service needs `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission, else `MissingForegroundServiceTypeException` crash on `startForeground`. (Plain `foregroundServiceType="vpn"` is NOT a valid AAPT value — it's specialUse + subtype property.)
9. **versionCode must increase every build** or Android silently keeps the old APK ("always installs old version" symptom). Auto-increment from `git rev-list --count HEAD`; name artifacts with the version so the right one is obvious.
10. **AGP 8+ needs `buildFeatures { buildConfig = true }`** or `BuildConfig` is unresolved.
11. **Add `block-ipv6`** to configs — VPN Gate servers rarely push working IPv6 and Android hangs on IPv6-first lookups ("connected but no internet").
12. `AUTH_FAILED` right after PUSH_REQUEST = **server full** (normal for free VPN Gate). Treat as fail-fast + failover, not an app bug.

## VPN Gate Source (free, no account)

- API: `https://www.vpngate.net/api/iphone/` (CSV, 15 columns, OpenVPN config base64 in col 15; `#` header, `*` footer). Server list changes constantly; free servers are a lottery — many dead/full/broken. Build auto-refresh (~5 min) + auto-failover that skips dead servers.
- `parse` rows with `split(",", limit=15)` (Message field contains commas). Cache raw text to filesDir for instant app-open.
- OvpnSpider-style apps aggregate multiple OVPN config sources — one source (VPN Gate) is enough to start but expect most servers to fail.

## GitHub Actions APK CI

- Gradle wrapper: fetch `gradlew` + `gradle-wrapper.jar` from the gradle GitHub repo at the matching version tag (e.g. `v8.7.0`), write `gradle-wrapper.properties` yourself.
- Workflow: `actions/checkout@v4` → `setup-java` (temurin 17) → `gradle/actions/setup-gradle@v4` → `chmod +x gradlew` → `./gradlew assembleDebug --no-daemon` → `upload-artifact` with `name: app-v0.1.${{ github.run_number }}`.
- Build errors surface as Kotlin `e: file:///...` lines in `--log-failed`; grep for `e: |error:|Unresolved|What went wrong`.

## Debugging Loop That Worked

1. Log EVERYTHING to a file (LogSaver: `filesDir/logs/debnet_<ts>.log`, append on every pushLog/state/error) + a "Share Logs" button (FileProvider + ACTION_SEND) so the user can hand you the transcript.
2. Version-stamp the log header AND the UI subtitle so you can tell which APK was actually installed (users repeatedly install stale artifacts).
3. Then read the transcript end-to-end: engine logs reveal the real error even when UI shows nothing.

## Support Files

- `references/openvpn3-pitfalls.md` — full error transcripts + root causes + exact fixes from a real build (cipher loop, DECRYPT_ERROR loop, timeout-kills-connection, state-stuck, connected-but-no-internet).
- `templates/build-apk-workflow.yml` — known-good GitHub Actions workflow for versioned APK artifacts.
