# Embedding OpenVPN3 in an Android app (no external app needed)

## Library choice
- `de.blinkt:openvpn` (ics-openvpn) is NOT published to Maven Central (404 on repo1.maven.org). JitPack builds for `schwabe/ics-openvpn` are broken for all 0.7.x ("Error" in the JitPack builds API).
- Use the Apache-2.0 fork published to Maven Central: `io.github.tim06:openvpn:1.1.3` (depends on `io.github.tim06:basevpnprotocols:1.1.0`). The AAR ships `jni/libovpn3.so` for arm64-v8a / armeabi-v7a / x86 / x86_64 plus `assets/pie_openvpn.*`.

## Engine
- `com.tim.openvpn.OpenVPNThreadv3(IOpenVPNService, configString)` extends `net.openvpn.ovpn3.ClientAPI_OpenVPNClient` (OpenVPN3); it does `System.loadLibrary("ovpn3")` itself. Run it on its own thread.
- It drives the TUN via callbacks into your service: `tun_builder_establish()` → `mService.openTun().detachFd()`, `tun_builder_add_address()` → `setLocalIP(CIDRIP)` / `setLocalIPv6`, `tun_builder_reroute_gw()` → `addRoute("0.0.0.0","0.0.0.0","127.0.0.1","vpnservice-tun")`, MTU arrives via `setMtu(int)` first.

## IOpenVPNService contract — Kotlin: nullable params + properties!
Inspect the real bytecode before implementing:
```
unzip -p openvpn-1.1.3.aar classes.jar > c.jar
javap -classpath c.jar com.tim.openvpn.service.IOpenVPNService
```
- Params are nullable: `addDNS(dns: String?)`, `addRoute(route: CIDRIP?, isVpn: Boolean)`, `addRoute(a: String?, b: String?, c: String?, d: String?)`, `addRoutev6(ip: String?, device: String?)`, `setDomain(domain: String?)`, `setLocalIP(ip: CIDRIP?)`, `setLocalIPv6(ip: String?)`, `trigger_sso(url: String?)`.
- Two members are **properties, not methods**: `val ctResolver: ContentResolver?`, `val connectivityManager: ConnectivityManager?` — override as Kotlin properties with getters. (Overriding them as `fun getX()` yields "overrides nothing" on every method.)
- `addHttpProxy(host: String?, port: Int): Boolean` → return `false` (not supported).
- `openTun(): ParcelFileDescriptor` → `vpnBuilder.establish()` (throws IllegalStateException if builder is null).
- `protectFd(socket: Int): Boolean` → `VpnService.protect(socket)`.
- `updateStateThread(state: ConnectionState)` → post to your state flow. `ConnectionState` enum: READYFORCONNECT, CONNECTED, CONNECTING, DISCONNECTED, DISCONNECTING, PERMISSION_NOT_GRANTED, IDLE.
- `openvpnStopped()` → engine ended; clean up builder/thread, stopForeground, stopSelf.

## VpnService.Builder setup
```kotlin
Builder().apply {
    setSession(serverName)
    setMtu(mtu)                              // engine reports mtu via setMtu(int) callback first
    setBlocking(true)
    addDisallowedApplication(packageName)     // exclude the app itself
}
```
Manifest: `BIND_VPN_SERVICE` permission on the `<service>` + `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />` + `FOREGROUND_SERVICE_SPECIAL_USE`. Do NOT set `android:foregroundServiceType="vpn"` — AAPT rejects it (not a valid FGS type at any API level). BUT do NOT omit the type either: on Android 14+ / targetSdk 34, `startForeground()` without a declared type throws `MissingForegroundServiceTypeException` at runtime. The pattern that works everywhere (and matches ics-openvpn's own manifest):
```xml
<service android:name=".vpn.XxxVpnService"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:exported="false"
    android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>
</service>
```

## Library bugs discovered in practice (tim06 1.1.3)
- **`VpnServiceConnection.start(config, …)` discards the config.** It only binds the service and calls `startVPN()`; the config parameter is dropped. The engine's `startOpenVPN()` then hits `requireNotNull(config)` → silent failure right after the notification appears (classic "VPN Service notification but nothing happens"). Config MUST be delivered via the intent extra `CONFIGURATION_KEY` using `OpenVPNService.Companion.startService(context, config, …)`; bind separately only to receive state callbacks.
- **`OpenVPNConfigParser` crashes with "fromIndex = -1"** on configs that lack a `<tls-crypt>` block (all VPN Gate configs): its `linesByKey()` does `indexOfFirst` for the closing tag and slices `start..end` with `-1`. Bypass: construct `OpenVPNConfig` manually (host/port/type parsed from the `remote`/`proto` lines) and set the `configuration` field to the raw config string — `startOpenVPN()` runs `conf.configuration ?: conf.buildConfig()`, so the raw config reaches the engine untouched.
- **Release AAR silences all engine logs.** `OpenVPNLogger` is guarded by `BuildConfig.DEBUG`, and the Maven AAR is a release build → `log()`/`event()` never print. Surface engine output by subclassing `OpenVPNThreadv3` (public ctor, not final) and overriding `log(ClientAPI_LogInfo)`, `event(ClientAPI_Event)`, and `connect()`; forward to a StateFlow shown in the UI. (Don't try to instantiate `ClientAPI_OpenVPNClient` directly — ctor is protected.)
- **`Thread.interrupt()` does not stop the engine** — native OpenVPN3 calls block the thread. Call `stopVPN()` on the `OpenVPNThreadv3` instance. Pair with a coroutine `withTimeout(20_000)` that invokes `stopVPN()` so a dead server doesn't leave the UI stuck in CONNECTING with a dead Cancel button.
- **`CIDRIP(String, String)` ctor is `internal`** — use the public `CIDRIP(ip, prefixInt)` and map netmask strings yourself (255.255.255.255→32, 255.255.255.0→24, 255.255.0.0→16, 255.0.0.0→8, 0.0.0.0→0).
- **Kotlin interface collision**: implementing both `IOpenVPNService` and your own `EngineCallback` in one class yields conflicting overloads (`setMtu`/`protectFd`/`openTun`). Implement ONE interface; route the other through a stub adapter object.

## VPN Gate (free config source, no account)
- Endpoint: `https://www.vpngate.net/api/iphone/` — CSV. Columns: HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64.
- Header row starts with `#`, footer with `*`. The Message field can contain commas → parse with `split(",", limit = 15)`.
- Config base64 is column 15; decode to text → feed straight to OpenVPNThreadv3 (CA cert is embedded in the config).
- Response is ~1.3 MB; a slow link may time out mid-download but the partial body still parses. Send a desktop/Android User-Agent header to be safe.
- Fields for sorting: Ping (ms), Speed (bytes/sec), Score (higher = healthier).
- **Mostly TCP-only servers.** UDP 1194 frequently times out on free gateways ("Server poll timeout" + `EVT RECONNECTING` loop). Prefer the config's own TCP proto (443/80/1194); don't auto-rewrite to UDP.
- **Free servers churn hard** — many are dead/full and handshake but never deliver data (TUN up, icon key appears, but never CONNECTED → Android "no internet"). For random picks filter `score > 0 && ping > 0` and pick from the top-scored tier. Append `dhcp-option DNS 1.1.1.1` / `8.8.8.8` to configs (some servers push no DNS).
- Stream-parse the CSV line-by-line (cache to a file) so the list populates progressively instead of waiting for the full 1.3 MB download.
