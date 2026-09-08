---
name: android-openvpn-integration
description: "Embed OpenVPN in Android apps: tim06 quirks, VPN Gate, CI."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, openvpn, vpn, tim06, openvpn3, vpngate, kotlin, gradle, github-actions]
    category: software-development
---

# Android OpenVPN Integration

## When to Use

- Building an Android VPN client that embeds OpenVPN (connect directly, no separate app install needed)
- Using the `io.github.tim06:openvpn` Maven library (ics-openvpn fork built on the OpenVPN3 engine)
- Fetching free server configs from VPN Gate (vpngate.net) for a "random country" style app
- Debugging Android OpenVPN failures: stuck "Connecting…", silent death after VPN-permission Allow, cancel button doing nothing, cipher errors

## Library Choice

- **`io.github.tim06:openvpn:1.1.3`** on Maven Central (Apache-2.0). Transitive deps: `io.github.tim06:basevpnprotocols` (1.1.1) and `io.github.tim06:vpnprotocolsnotification` — pin versions explicitly.
- `de.blinkt:openvpn` does NOT exist on Maven Central (404). JitPack is broken for schwabe/ics-openvpn 0.7.x (every build errors). Don't waste time on either.
- The AAR ships `jni/*/libovpn3.so` for all 4 ABIs + `assets/pie_openvpn.*` — the engine is bundled, no extra NDK work.

## Confirmed Library Bugs (all hit in real use — read before writing code)

1. **`OpenVPNConfigParser.parse()` crashes on most real configs**: `linesByKey("<tls-crypt>")` does `indexOfFirst` then slices `start..end` — returns index -1 when the config lacks a `<tls-crypt>` block → `fromIndex = -1` exception. VPN Gate configs trigger this every time. **Workaround**: bypass the parser entirely. Build `OpenVPNConfig(host=…, port=…, type=…, configuration=<raw config text>)` manually — the service runs `conf.configuration ?: conf.buildConfig()`, so raw config is used verbatim.

2. **`VpnServiceConnection.start(config, …)` silently DROPS the config**: its `start()` only binds the service and calls `startVPN()`; the config param is never delivered. Config ONLY reaches the service via an intent extra `CONFIGURATION_KEY` (use `OpenVPNService.Companion.startService(ctx, config, …)` or hand-build the intent with `ProtocolsVpnService.ACTION_KEY` = `ACTION_START_KEY`). Symptom of this bug: notification appears, but the service dies silently on `requireNotNull(config)` → "clicked Allow, no effect".

3. **Engine logs are swallowed in the release AAR**: `OpenVPNLogger` gates on `BuildConfig.DEBUG`, and the Maven AAR is a release build → zero engine output. This is why "no error shows". **Fix**: subclass `OpenVPNThreadv3` (it is NOT final) and override `log(ClientAPI_LogInfo)`, `event(ClientAPI_Event)`, and `connect()` (check `ClientAPI_Status.error`) to capture everything to your own logger.

4. **`IOpenVPNService` is a Kotlin interface with nullable params AND properties**: override `addDNS(dns: String?)`, `addRoute(cidrip: CIDRIP?, …)` with nullable types, and `ctResolver` / `connectivityManager` as `override val … get() = …` properties, NOT `getX()` functions. Wrong signatures → "overrides nothing" compile errors.

5. **`CIDRIP(String, String)` constructor is `internal`** — only `CIDRIP(String, int)` (ip, prefix-length) is public. Convert netmasks to prefix lengths yourself.

## Android 14+ Foreground Service (crash: `MissingForegroundServiceTypeException`)

A VPN service MUST declare, or `startForeground` crashes on targetSdk 34+:

```xml
<service
    android:name=".vpn.DebVpnService"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:exported="false"
    android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn" />
</service>
```

- `foregroundServiceType="vpn"` is NOT a valid value (AAPT rejects it). It's `specialUse` + the `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property (same pattern as ics-openvpn upstream).
- Add `FOREGROUND_SERVICE_SPECIAL_USE` permission.

## Connection Failures — the Cipher Issue

VPN Gate configs ship the deprecated `cipher AES-128-CBC`. OpenVPN3 rejects CBC for the data channel:
`crypto_alg: AES-128-CBC: bad cipher for data channel use` — handshake & tunnel succeed, then the core loops `Client terminated, restarting in 2000 ms...` forever.

**APPENDING `data-ciphers` to the config does NOT fix it** — the server still pushes/forces CBC in its reply and the core still rejects it. The fix is to **STRIP every `cipher` / `data-ciphers` / `keysize` / `connect-retry` line** (case-insensitive, whitespace-tolerant filter over `config.lines()`) and inject a clean block:

```
cipher CHACHA20-POLY1305
data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
remote-cert-tls server
dhcp-option DNS 1.1.1.1
dhcp-option DNS 8.8.8.8
connect-retry 1 1
connect-retry-max 1
block-ipv6
```

- **ChaCha20-POLY1305 FIRST** (not AES-GCM): several SoftEther/VPN Gate servers have an AES-GCM data-channel bug → `Session invalidated: DECRYPT_ERROR` right after CONNECTED. ChaCha20 avoids most of it.
- `connect-retry-max 1` stops the core's internal reconnect loop on the SAME server — let YOUR failover pick the next server instead.
- `block-ipv6` prevents Android probing IPv6 first and hanging (VPN Gate servers rarely push IPv6 correctly) — this is a top cause of "CONNECTED but no internet".

## Stop/Cancel That Actually Works

- `Thread.interrupt()` does NOT stop the native OpenVPN3 connect — you MUST call `stopVPN()` on the `OpenVPNThreadv3` instance.
- **Race condition**: assign `management = thread` BEFORE `thread.start()`. If assigned inside the thread body, `stopEngine()` from the main thread sees null → cancel does nothing.
- Wrap the engine run in `withTimeout(20_000)` on a coroutine; on timeout call `stopEngine()` (which calls `stopVPN()` + cancels + interrupts).

## THE three state bugs that make the app look dead (hit in real use, in order of "wow that was it")

1. **Must call `super.event(e)` in your `event()` override.** The base `OpenVPNThreadv3.event()` maps EVT names (CONNECTING/CONNECTED/DISCONNECTED/AUTH_FAILED) to `updateStateThread()` → your UI state. If you override `event()` only to log and never call `super.event(e)`, the engine REALLY connects (`EVT CONNECTED` appears in your captured log) but the UI stays "Connecting…" forever, the Cancel button appears dead, and failover never triggers (state never becomes DISCONNECTED/IDLE). Symptom: engine log says CONNECTED, screen says Connecting.
2. **Timeout watchdog must stop when state == CONNECTED.** The engine thread stays ALIVE during a healthy session (it polls status). A watchdog that only loops `while (thread.isAlive) delay(500)` will fire at 20s and KILL a working connection — log shows `EVT CONNECTED` then `TIMEOUT 20s — cancelling engine`. Loop condition must be `thread.isAlive && state != ConnectionState.CONNECTED`, and the catch block must double-check `state != CONNECTED` before cancelling.
3. **Never hardcode an address/route in the VpnService.Builder.** The engine adds the server-pushed IP, routes and DNS via the callbacks. Adding your own `addAddress("10.111.0.2", 24)` / `addRoute("0.0.0.0", 0)` collides with the pushed `10.x.y.z/30` → routing is garbage → **CONNECTED but no internet** ("bengong"). Keep the Builder to `setSession` + `setMtu` + `setBlocking(true)` only.

## VPN Gate server failure semantics (what the errors mean)

- `AUTH_FAILED` after PUSH_REQUEST = server is FULL (max users reached). Normal for free servers — this is the most common outcome.
- `Session invalidated: DECRYPT_ERROR` = broken server (SoftEther AES-GCM bug).
- `Transport Error: TCP connect error ... Connection refused / No route to host` = dead server.
- Detection strategy: in the `log()` override, on `DECRYPT_ERROR` / `Session invalidated` call `stopEngine()` (via a coroutine) — reporting the error alone is NOT enough because the core keeps reconnecting to the same broken server. On `AUTH_FAILED` (event) just report and let the IDLE state trigger failover.
- Auto-failover loop: keep a `deadServers` set, pick the next server after IDLE+DISCONNECTED, `delay(1500)` then RE-CHECK a `userCancelled` flag (user may have hit Cancel during the wait) before connecting. Stop when the pool is exhausted and show the error instead of looping forever.

## VPN Gate API (free configs)

- Endpoint: `https://www.vpngate.net/api/iphone/` — CSV. Header: `#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,...,OpenVPN_ConfigData_Base64` (15 columns, config base64 = last). Skip `#` and `*` lines.
- Many servers are dead/full: for random pick, filter `score > 0 && ping > 0`, sort by score desc, pick from the top ~60%.
- Stream-parse lines as they arrive (chunked) so the list populates progressively; cache the raw text for instant app-startup display.
- UDP 1194 is unreliable on VPN Gate — TCP (as shipped in the configs) works far better. Don't auto-rewrite proto to UDP.

## CI Build (GitHub Actions)

- AGP 8.5.2 is only tested up to **compileSdk 34**; compileSdk 35 breaks AAPT on flags. Use compileSdk/targetSdk 34 with AGP 8.5.x.
- `buildFeatures { buildConfig = true }` is REQUIRED in AGP 8+ before `BuildConfig.VERSION_NAME` is available — otherwise "Unresolved reference: BuildConfig".
- **`versionCode` MUST increase every build** or Android silently refuses to install the new APK (keeps the old one; user thinks they installed the new version). Derive it from the commit count: `versionCode = <git rev-list --count HEAD>` and `versionName = "0.1.<count>"`. Name CI artifacts `app-v0.1.${{ github.run_number }}` so users can't grab a stale artifact, and stamp the version in the UI subtitle + log file header so you can verify which build is actually installed.
- Gradle wrapper without Android Studio: fetch `gradlew` + `gradle-wrapper.jar` from the gradle/gradle repo at the matching tag (e.g. v8.7.0), and write `gradle-wrapper.properties` with the distributionUrl.
- Minimal workflow: `actions/checkout@v4` → `actions/setup-java@v4` (temurin 17) → `gradle/actions/setup-gradle@v4` → `./gradlew assembleDebug --no-daemon` → `actions/upload-artifact@v4`.

## Debugging Workflow That Works

1. Add a file logger (internal storage `filesDir/logs/`) + a "Share logs" button (FileProvider) early — the user can then send you the real engine log instead of screenshots.
2. Look for the FIRST error line in the engine log, not the timeout: e.g. `bad cipher for data channel use` pinpoints the cipher fix instantly.

## Support Files

- `references/tim06-openvpn-library.md` — verified API surface (javap signatures), integration flow, event/state mapping.
