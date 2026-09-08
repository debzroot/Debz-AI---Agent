# OpenVPN Engine Integration (tim06 AAR on Maven Central)

Coordinates (all on Maven Central):
- `io.github.tim06:openvpn:1.1.3` — engine AAR (OpenVPN3 SWIG bindings, native `libovpn3.so` for arm64-v8a / armeabi-v7a / x86 / x86_64 in `jni/`)
- Transitive deps (from its POM — pin explicitly): `io.github.tim06:basevpnprotocols` (1.1.1 latest) and `io.github.tim06:vpnprotocolsnotification` (notification helper classes `com.tim.notification.*`). The openvpn POM pins basevpnprotocols 1.1.0 — pin 1.1.1 if you verified against it.
- Upstream source: `github.com/tim06/VPNProtocols` (SCM in POM). Engine lineage: ics-openvpn (schwabe) → OpenVPN3.
- The **JitPack route for ics-openvpn is broken** (all 0.7.x builds Error) and `de.blinkt:openvpn` does NOT exist on Maven Central — the tim06 fork is the working Maven path.

## Library bug #1: config is never delivered to the service
`VpnServiceConnection.start(config, ...)` accepts the config then **discards it** — it only `bindService` + `startVPN()`. The config reaches the service ONLY via the start intent extra (`CONFIGURATION_KEY`) through `OpenVPNService.Companion.startService()` which sets `ACTION_KEY=ACTION_START_KEY`.

Symptom: notification "VPN Service" appears, state flashes CONNECTING, then silent disconnect. `OpenVPNService.startOpenVPN()` does `requireNotNull(config)` → throws inside the service process.

Fix: skip `VpnServiceConnection` entirely.
- Start: `Intent(context, YourService::class.java)` with extras `ACTION_KEY=ACTION_START_KEY`, `CONFIGURATION_KEY` = Parcelable `OpenVPNConfig`, `NOTIFICATION_CLASS_KEY` = null, `ALLOWED_APPS_KEY` = emptyArray; `startForegroundService()` on API 26+, else `startService()`.
- State: bind manually, `IVPNService.Stub.asInterface(binder)`, `registerCallback(ConnectionListener)` — `ConnectionListener` is an abstract class extending `IConnectionStateListener.Stub()`.

## Library bug #2: OpenVPNConfigParser crashes without `<tls-crypt>`
`configFromLines()` calls `linesByKey("<tls-crypt>")` unconditionally; `indexOfFirst` returns -1 when absent → `slice(-1..0)` → exception **"fromIndex = -1"**. VPN Gate configs have no tls-crypt, so every parse crashes.

Fix: **bypass the parser**. Build `OpenVPNConfig` manually (host/port from the `remote` line, proto from `proto` line → `"tcp-client"`/`"udp-client"`) and set `configuration = <raw config text>`. `OpenVPNService.startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()` — raw config goes straight to the engine.

## Engine logs are swallowed in release AARs
`OpenVPNLogger`/`VpnStatus` log only when `BuildConfig.DEBUG` — Maven AARs are release → **zero logs** (looks like "nothing happens"). To see real errors:
- `OpenVPNThreadv3` is NOT final → subclass and override `log(ClientAPI_LogInfo?)`, `event(ClientAPI_Event?)` (report on `error`/`fatal`), `connect()` (check `ClientAPI_Status.error`).
- `OpenVPNService` IS final → **fork it**: copy its source into your app package, swap in your thread subclass, wrap `management.run()` in try/catch, report errors and reset state.
- Route captured logs into a `StateFlow<List<String>>` the UI collects (overlay text) — never rely on logcat when debugging through chat.
- Avoid library-internal members: `VpnStatus` object is `internal`; `CIDRIP(String, String)` (netmask) constructor is `internal` — use public `CIDRIP(ip, prefixInt)` and map netmasks → prefixes yourself (255.255.255.255→32, 255.255.255.0→24, 255.255.0.0→16, 255.0.0.0→8, 0.0.0.0→0).

## Manifest pattern (Android 14+ correct — matches ics-openvpn)
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
...
<service
    android:name=".vpn.DebOpenVpnService"
    android:exported="true"
    android:foregroundServiceType="specialUse"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:process=":openvpn">
    <intent-filter><action android:name="android.net.VpnService" /></intent-filter>
    <meta-data android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON" android:value="false" />
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn" />
</service>
```
- `vpn` is NOT a valid `foregroundServiceType` value — AAPT rejects it with a flags list. `specialUse` + the PROPERTY is the official VPN pattern.
- `android:process=":openvpn"` isolates the service; its `onDestroy` calls `exitProcess(0)` (ics-openvpn pattern) — check process name first so the main app isn't killed.
- Connect flow: `VpnService.prepare(ctx)` → null = already granted; else launch the returned Intent and on RESULT_OK start the service. Ask POST_NOTIFICATIONS (API 33+) before starting.

## VPN Gate API (free OVPN config source, no account)
- Endpoint: `https://www.vpngate.net/api/iphone/` — plain CSV, ~1.3 MB, slow-ish on first hit (stream it).
- Format: header row starts `#`, footer row starts `*`; 15 columns; **OpenVPN config base64 is column 15 (index 14)**; the Message field can contain commas → `split(",", limit = 15)`.
- Configs carry client cert + key, NO user/pass (`provide_creds` not needed). No `<tls-crypt>` (see bug #2). Common: `cipher AES-128-CBC`, `auth SHA1`, `remote <ip> <port>`, proto tcp.
- UX pattern for slow fetch: stream-parse line-by-line (`okhttp3` `source.readUtf8Line()`), push batches (≈6) to the UI as they arrive, cache the raw text in `filesDir` so reopening the app shows the list instantly, and render each new item with a scale-in animation instead of a blocking spinner.
- Random-pick logic: filter by country, `Random.nextInt(pool.size)`.
