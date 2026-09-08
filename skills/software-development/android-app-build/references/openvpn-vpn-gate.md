# Embedding OpenVPN3 in an Android app + VPN Gate free-server API

Session-proven recipe (DebNet+ app, build via GitHub Actions). Verify library APIs with `javap` before coding — details below were checked against the actual 1.1.3 artifact.

## Library choice
- Maven Central: `io.github.tim06:openvpn:1.1.3` + pin `io.github.tim06:basevpnprotocols:1.1.1` (transitive dep; pin what you inspected).
- **Dead ends**: JitPack `com.github.schwabe:ics-openvpn` — ALL v0.7.x builds report "Error" (broken). Maven Central `de.blinkt:openvpn` — 404, never published. Don't waste time on either.
- AAR contents: `jni/<abi>/libovpn3.so` (arm64-v8a, armeabi-v7a, x86, x86_64), `assets/pie_openvpn.<abi>`, classes.jar. License Apache-2.0.
- AAR's own manifest (merged into your app) declares the full service: `com.tim.openvpn.service.OpenVPNService`, `android:process=":openvpn"`, exported, `BIND_VPN_SERVICE` permission, `foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>`. **Do NOT redeclare the service in your manifest.**

## Integration — use the library's own service, do NOT implement IOpenVPNService
Implementing `IOpenVPNService` yourself (VpnService + 14 callback methods) is the trap: it looks right, builds fine, but connect is dead because the engine runs in its own process. The library ships `VpnServiceConnection` + a ready service — use them:

```kotlin
// VpnController.kt (singleton object)
private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
private var connection: VpnServiceConnection? = null
private val _state = MutableStateFlow(ConnectionState.IDLE)

fun start(context: Context, config: String, serverName: String) {
    val parsed = OpenVPNConfigParser.parse(config)          // String → OpenVPNConfig (IVpnConfiguration)
    connection?.stop()
    connection = object : VpnServiceConnection(             // ABSTRACT → anonymous subclass
        context.applicationContext,
        OpenVPNService::class.java,
        { st -> _state.value = st },                        // state callback, Main thread
        scope
    ) {}
    connection?.start(parsed, emptySet(), serverName)
}

fun stop() {
    connection?.stop()
    connection?.stopServiceIfNeed(true)
    connection = null
    _state.value = ConnectionState.IDLE
}
```

- `ConnectionState` enum: IDLE, READYFORCONNECT, CONNECTING, CONNECTED, DISCONNECTING, DISCONNECTED, PERMISSION_NOT_GRANTED (parcelable, from basevpnprotocols).
- Permission flow: `VpnService.prepare(ctx)` returns a non-null Intent when permission isn't granted → launch via `ActivityResultContracts.StartActivityForResult`, hold the pending (name, config), call start on `RESULT_OK`.
- Android 13+: request `POST_NOTIFICATIONS` at startup.
- Manifest permissions needed: `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`.
- `VpnServiceConnection` has no abstract members — `object : VpnServiceConnection(...) {}` compiles. Direct instantiation gives "Cannot create an instance of an abstract class".

### If you ever DO implement IOpenVPNService (re-hosting the engine)
Exact contract from `javap com.tim.openvpn.service.IOpenVPNService` (1.1.3) — ALL params nullable, two Kotlin `val` properties:
`setMtu(Int)`, `addDNS(String?)`, `addRoute(CIDRIP?, Boolean)`, `addRoute(String?, String?, String?, String?)`, `addRoutev6(String?, String?)`, `setDomain(String?)`, `addHttpProxy(String?, Int): Boolean`, `openTun(): ParcelFileDescriptor`, `setLocalIP(CIDRIP?)`, `setLocalIPv6(String?)`, `protectFd(Int): Boolean`, `trigger_sso(String?)`, `val ctResolver: ContentResolver?`, `val connectivityManager: ConnectivityManager?`, `openvpnStopped()`, `updateStateThread(ConnectionState)`.
Wrong nullability or overriding `getCtResolver()` as a function → every member reports "overrides nothing".

## VPN Gate free server API (no key, no account)
- Endpoint: `https://www.vpngate.net/api/iphone/` — plain CSV text. Line 1 `*vpn_servers`, `#`-prefixed header, data rows, `*` footer.
- 15 columns: HostName, IP, Score, Ping, Speed, CountryLong, CountryShort, NumVpnSessions, Uptime, TotalUsers, TotalTraffic, LogType, Operator, Message, **OpenVPN_ConfigData_Base64**.
- **The Message field can contain commas** → parse with `line.split(",", limit = 15)`; config = `parts[14]`.
- Config base64 decodes to a complete .ovpn (embedded CA) — works as-is with the engine.
- Response ~1.3 MB, can exceed a 30s curl timeout mid-body — a partial download is still parseable. Cache the raw text to `context.filesDir` so the app shows the list instantly on next launch; refresh in background (cache-then-refresh pattern).
- `User-Agent` header on the request helps; servers list is 500+ rows / 60+ countries.

## Canonical ics-openvpn FGS pattern (reference)
https://github.com/schwabe/ics-openvpn — `main/src/main/AndroidManifest.xml` shows the correct modern VPN-service declaration: `foregroundServiceType="specialUse"`, `android:process=":openvpn"`, `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>`.
