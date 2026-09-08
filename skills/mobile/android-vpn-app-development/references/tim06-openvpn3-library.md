# tim06 OpenVPN3 library API notes (io.github.tim06:openvpn:1.1.3)

Reverse-engineered from the sources jar + javap. Verified working integration for a Kotlin/Compose app.

## Key classes

- `com.tim.openvpn.OpenVPNThreadv3` — the engine runner. **Not final**; construct with `(IOpenVPNService, String config)`. Override `log()`, `event()`, `connect()` to capture what the release AAR hides. Has public `stopVPN()`.
- `com.tim.openvpn.service.IOpenVPNService` — tun-builder callback interface the engine calls. Kotlin-written: some members are **properties**, not functions (`val ctResolver: ContentResolver?`, `val connectivityManager: ConnectivityManager?`) — override as properties or "overrides nothing" errors. String params are **nullable** (`addDNS(String?)` etc.) — match or you get "overrides nothing".
- `com.tim.openvpn.OpenVPNConfigParser` — **BROKEN for VPN Gate configs**: `linesByKey("<tls-crypt>")` does `subList(-1, 0)` when the config lacks a tls-crypt block → `fromIndex = -1` crash. Do NOT use it; build `OpenVPNConfig` manually.
- `com.tim.openvpn.configuration.OpenVPNConfig` — `OpenVPNService.startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()`. Set `configuration = rawConfigString` to hand the engine the exact config you want (bypasses the broken parser).
- `com.tim.basevpn.connection.VpnServiceConnection` — abstract; `start(config)` **discards the config** (bug: only binds + `startVPN()`; config never reaches the service). Don't use for config delivery; start via intent extra `CONFIGURATION_KEY` instead.
- `net.openvpn.ovpn3.ClientAPI_*` — SWIG JNI bindings (Config, Event, Status, LogInfo, OpenVPNClient, TunBuilderBase...). `ClientAPI_OpenVPNClient` constructors are protected; the sane path is subclassing `OpenVPNThreadv3`, not these directly.

## Event → state mapping (in OpenVPNThreadv3.event base impl)

```
RESOLVE, WAIT, RECONNECTING, CONNECTING, GET_CONFIG, ASSIGN_IP, RENEG -> ConnectionState.CONNECTING
CONNECTED  -> ConnectionState.CONNECTED
DISCONNECTED -> ConnectionState.DISCONNECTED
```
These flow into `IOpenVPNService.updateStateThread(state)`. **If you override `event()`, call `super.event(e)` or replicate this mapping yourself** — skipping it leaves UI state frozen on CONNECTING while the tunnel is actually connected.

## AIDL / bind path (if using library's own service instead of your own VpnService)

- `IVPNService.Stub` (startVPN/stopVPN/getState/registerCallback/unregisterCallback)
- `IConnectionStateListener` (stateChanged, trafficUpdate)
- `VpnServiceConnection.attachStateListener` uses `callbackFlow` over AIDL callbacks.
- The library's own `OpenVPNService` manifest pattern (Android 14 correct):
  `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `android:process=":openvpn"`.

## Notifications

`NotificationVpnService.initNotification` reflectively loads a class named by `NOTIFICATION_CLASS_KEY` extra; default fallback `com.tim.notification.DefaultVpnServiceNotification` lives in the **vpnprotocolsnotification** artifact (transitive dep).

## Debugging flow that worked

1. Subclass OpenVPNThreadv3, forward every `log()` line + `event()` + connect errors into a `StateFlow<List<String>>` engine-log and a `LogSaver` (file in `filesDir/logs/`).
2. Add a "Share Logs" button (FileProvider + ACTION_SEND) so the user can send the log file to you. Without this you are debugging blind — the release AAR logs NOTHING.
3. Version-stamp both the log header and the app subtitle (`BuildConfig.VERSION_NAME`) so you can tell which APK a log came from.
