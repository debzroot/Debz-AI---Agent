# tim06 OpenVPN3 engine — API surface & quirks

Reverse-engineered from `io.github.tim06:openvpn:1.1.3` AAR (Maven Central) while building DebNet+. The AAR is a release build — `OpenVPNLogger` only logs when `BuildConfig.DEBUG` is true, so **ALL engine logs are swallowed by default**. Capture logs by subclassing and overriding `log()`/`event()`.

## Key classes

| Class | Notes |
|---|---|
| `com.tim.openvpn.OpenVPNThreadv3` | Engine runner. Constructor `(IOpenVPNService, String config)`. NOT final — subclass it. Runs `connect()` on whatever thread you call `run()` from; wraps native OpenVPN 3 (libovpn3.so, SWIG bindings `net.openvpn.ovpn3.*`). |
| `com.tim.openvpn.service.IOpenVPNService` | Callback interface the engine calls into (see contract below). Kotlin interface with NULLABLE params. |
| `com.tim.openvpn.configuration.OpenVPNConfig` | Parcelable config holder. `buildConfig()` rebuilds from fields; but if `.configuration` (raw string) is set, `OpenVPNService.startOpenVPN()` uses it verbatim. |
| `com.tim.openvpn.OpenVPNConfigParser` | BROKEN for VPN Gate configs: `linesByKey("<tls-crypt>")` does `slice(startIndex..endIndex)` with unguarded `indexOfFirst` → returns -1 → `subList(-1, 0)` → **"fromIndex = -1" crash**. Don't use it; build config manually. |
| `com.tim.openvpn.service.OpenVPNService` | The library's own VpnService (process `:openvpn`, AIDL binder). Avoid: its companion `VpnServiceConnection.start(config)` **never delivers the config to the service** (param dropped; only binds + calls `startVPN()`), so `requireNotNull(config)` throws and connect dies silently. Also final-ish to subclass meaningfully. |
| `com.tim.basevpn.state.ConnectionState` | IDLE, READYFORCONNECT, CONNECTED, CONNECTING, DISCONNECTING, DISCONNECTED, PERMISSION_NOT_GRANTED. |

## IOpenVPNService contract (implement yourself in your VpnService)

```kotlin
fun setMtu(mtu: Int)
fun addDNS(dns: String?)
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
val ctResolver: ContentResolver?   // Kotlin property, not getCtResolver()
val connectivityManager: ConnectivityManager?  // Kotlin property
fun openvpnStopped()
fun updateStateThread(state: ConnectionState)
```

Gotchas when implementing:
- `CIDRIP(String, String)` (mask form) is **internal** — use `CIDRIP(ip, prefixInt)` and map masks yourself (255.255.255.0→24, etc.).
- `ctResolver` / `connectivityManager` are **Kotlin properties** — override as `override val`, NOT `override fun getX()` (compile error "overrides nothing").
- Params are **nullable** in the interface — declare `String?` or you get "overrides nothing".

## Event/state mapping (from OpenVPNThreadv3.java source)

`event(ClientAPI_Event)` maps names: RESOLVE/WAIT/RECONNECTING/CONNECTING/GET_CONFIG/ASSIGN_IP/RENEG → CONNECTING; CONNECTED → CONNECTED; DISCONNECTED → DISCONNECTED. **This mapping lives in the parent `event()` — you MUST call `super.event(e)` in any override or UI state never updates.** Auth/log events: INFO, WARN, COMPRESSION_ENABLED (logged only).

## Log line patterns (diagnostic gold)

- `Session invalidated: DECRYPT_ERROR` — SoftEther AES-GCM bug; server broken, move on.
- `Session invalidated: KEEPALIVE_TIMEOUT` — server offline/Doze killed client pings; if client-side, fix = wakelock.
- `AUTH_FAILED` — server full (not bad creds).
- `Client terminated, restarting in 2000 ms...` — core auto-reconnect loop; `connect-retry-max 1` does NOT stop this for session-invalidated; must call `stopVPN()` yourself (fail-fast).
- `Transport Error: TCP connect error ... Connection refused` — server down; health-check filter handles.
- `Unsupported option (ignored) N [data-ciphers] ...` — engine parsed a line it didn't understand; harmless noise.

## Useful native methods (net.openvpn.ovpn3.ClientAPI_OpenVPNClient)

`setConfig(String)`, `connect(): ClientAPI_Status`, `stop()`, `event(ClientAPI_Event)`, `log(ClientAPI_LogInfo)`, `provide_creds(ClientAPI_ProvideCreds)` (override to auto-send vpn/vpn), `eval_config`, `transport_stats()`. SWIG-director pattern: override methods in a Kotlin/Java subclass of OpenVPNThreadv3 and they get called from native code.
