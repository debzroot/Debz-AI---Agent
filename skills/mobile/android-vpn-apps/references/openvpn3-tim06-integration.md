# OpenVPN3 / tim06 library integration — API contract & confirmed bugs

Source of truth: decompiled `io.github.tim06:openvpn:1.1.3` AAR + `io.github.tim06:basevpnprotocols:1.1.1` (sources jars ship most Kotlin sources; `main` module is a Java+SWIG mix). Verified August 2026.

## Dependency setup
```kotlin
implementation("io.github.tim06:openvpn:1.1.3")
implementation("io.github.tim06:basevpnprotocols:1.1.1") // pin; transitive is 1.1.0
```
Third artifact `io.github.tim06:vpnprotocolsnotification` (provides `com.tim.notification.*`) resolves transitively.
Native libs: `jni/*/libovpn3.so` for arm64-v8a, armeabi-v7a, x86, x86_64.

## Engine flow (how OpenVPNThreadv3 works)
- `OpenVPNThreadv3(IOpenVPNService, String config)` — public, NOT final. Loads `libovpn3` in a static block.
- `run()`: `setConfig(config)` → `connect()` → blocks until session ends; emits events via `event()` callback.
- Engine drives the TUN via callbacks on `IOpenVPNService` (the app must provide a `VpnService`-backed implementation).
- `stop()` → `mHandlerThread.quit()` + `mService.openvpnStopped()`.
- Auto-restart loop: on failure it logs `Client terminated, restarting in 2000 ms...` and reconnects internally. `connect-retry-max 1` in config limits this for connect-phase failures, but a `Session invalidated` mid-session still loops → the app must detect and `stopVPN()` itself (fail-fast), then failover.

## IOpenVPNService contract (Kotlin — nullable signatures!)
Implementing with non-null params yields `'X' overrides nothing`. Use exact nullable types:
```kotlin
fun setMtu(mtu: Int)
fun addDNS(dns: String?)                       // note: param named dns
fun addRoute(route: CIDRIP?, include: Boolean)
fun addRoute(dest: String?, mask: String?, gateway: String?, device: String?)
fun addRoutev6(network: String?, device: String?)
fun setDomain(domain: String?)
fun addHttpProxy(host: String?, port: Int): Boolean
fun openTun(): ParcelFileDescriptor?
fun setLocalIP(cidrip: CIDRIP?)
fun setLocalIPv6(ipv6addr: String?)
fun protectFd(fd: Int): Boolean
fun trigger_sso(url: String?)
val ctResolver: ContentResolver?        // PROPERTY, not getCtResolver()
val connectivityManager: ConnectivityManager? // PROPERTY
fun openvpnStopped()
fun updateStateThread(state: ConnectionState)
```
`CIDRIP(ip: String, prefix: Int)` is public; `CIDRIP(ip, maskString)` is internal — convert netmask → prefix yourself.

## Event names mapped to ConnectionState (base impl of `event()`)
`RESOLVE/WAIT/RECONNECTING/CONNECTING/GET_CONFIG/ASSIGN_IP` → CONNECTING; `CONNECTED` → CONNECTED; `DISCONNECTED` → DISCONNECTED. Errors come as `event.error=true` (e.g. `AUTH_FAILED`).
**Override `event()` but ALWAYS call `super.event(e)`** or state never reaches the UI.

## Engine log capture
`OpenVPNLogger` only logs when `BuildConfig.DEBUG` — Maven release AAR has DEBUG=false → ALL engine output silently swallowed. Subclass `OpenVPNThreadv3` and override:
- `log(ClientAPI_LogInfo)` → push `text` to your buffer
- `event(ClientAPI_Event)` → push `name + info`, detect error strings
- `connect()` → wrap, surface `status.message` on error
Useful log markers: `Connected via tun`, `Session invalidated: <REASON>`, `AUTH_FAILED`, `Client exception in transport_recv`.

## Confirmed bugs (all hit in production)
1. `OpenVPNConfigParser.parse()` → `indexOfFirst` returns -1 for missing `<tls-crypt>` → `subList(-1,0)` → `fromIndex = -1` crash. VPN Gate configs never have tls-crypt.
2. `VpnServiceConnection.start(config, ...)` drops the config — only `bindService` + `startVPN()` happen. `OpenVPNService.startOpenVPN()` then hits `requireNotNull(config)` → silent death (notification appears, nothing else).
3. `OpenVPNService` class is `final` → fork or run engine in-process.
4. `IntentActionVpnService.onStartCommand` requires an Intent with an `ACTION_KEY` extra; config must ride in `CONFIGURATION_KEY` parcelable extra (use `getParcelableExtra(name, OpenVPNConfig::class.java)` on T+).

## Working integration pattern (DebNet+ final architecture)
- Own `VpnService` (subclass `android.net.VpnService`) in the app process, NOT a separate `:openvpn` process.
- Build `VpnProfile` manually: parse `remote`/`proto` lines from raw config, then pass sanitized raw config to `OpenVPNThreadv3` via an `IOpenVPNService` adapter that forwards callbacks to the VpnService Builder.
- Engine thread wrapped in try/catch; log/event/connect overridden for capture; 20s connect timeout coroutine that polls `engineThread.isAlive && state != CONNECTED` (must stop when CONNECTED or it kills healthy sessions).
- `stopEngine()` MUST call `(management as? OpenVPNThreadv3)?.stopVPN()` — `Thread.interrupt()` alone cannot stop native `connect()`; also set state IDLE so the overlay closes.
