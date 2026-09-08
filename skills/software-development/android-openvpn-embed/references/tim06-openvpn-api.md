# tim06 OpenVPN library — API contract (verified via javap, v1.1.3)

Library: `io.github.tim06:openvpn:1.1.3` (+ `io.github.tim06:basevpnprotocols:1.1.1`).
Repos: github.com/tim06/VPNProtocols (upstream, no README), fork of schwabe/ics-openvpn.

## AAR manifest (com.tim.openvpn)
```xml
<service android:name="com.tim.openvpn.service.OpenVPNService"
    android:exported="true" android:foregroundServiceType="specialUse"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:process=":openvpn">
  <intent-filter><action android:name="android.net.VpnService"/></intent-filter>
  <meta-data android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON" android:value="false"/>
  <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>
</service>
```

## IOpenVPNService (Kotlin interface — nullable params, property getters)
```kotlin
fun setMtu(mtu: Int)
fun addDNS(dns: String?)
fun addRoute(route: CIDRIP?, isVpn: Boolean)
fun addRoute(a: String?, b: String?, c: String?, d: String?)
fun addRoutev6(ip: String?, device: String?)
fun setDomain(domain: String?)
fun addHttpProxy(host: String?, port: Int): Boolean
fun openTun(): ParcelFileDescriptor?      // engine calls .detachFd()
fun setLocalIP(ip: CIDRIP?)
fun setLocalIPv6(ip: String?)
fun protectFd(socket: Int): Boolean
fun trigger_sso(url: String?)
val ctResolver: ContentResolver?          // PROPERTY, not getCtResolver()
val connectivityManager: ConnectivityManager?  // PROPERTY
fun openvpnStopped()
fun updateStateThread(state: ConnectionState)
```

## OpenVPNService (the ready-made service, extends ProtocolsVpnService)
Public API: `prepare(intent)`, `start()`, `stop()`, `onRevoke()`, `onDestroy()`,
`handleMessage(Message)`, plus full IOpenVPNService impl (openTun builds the
VpnService.Builder: adds local IP, DNS, routes incl. Android 13+ excludeRoute,
setUnderlyingNetworks(null), setMetered(false), session "VPN Session").
Key behavior: `startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()`
→ **raw config string wins** (this is the parser-bypass hook).

Companion:
```kotlin
fun startService(context, config: OpenVPNConfig, notificationClass: String? = null,
                 allowedApplications: Array<String> = emptyArray())
fun stopService(context)
```
Extras: ACTION_KEY/ACTION_START_KEY/ACTION_STOP_KEY, CONFIGURATION_KEY,
NOTIFICATION_CLASS_KEY, ALLOWED_APPS_KEY (defined in ProtocolsVpnService companion).

## VpnServiceConnection (basevpnprotocols — ABSTRACT, use anonymous subclass)
```kotlin
class VpnServiceConnection(
    context: Context,
    clazz: Class<out Service>,            // OpenVPNService::class.java
    stateListener: (ConnectionState) -> Unit,
    scope: CoroutineScope
)
fun start(config: IVpnConfiguration, allowedApps: Set<String>, name: String)
fun stop()
suspend fun isConnected(): Boolean
fun attachListener()
fun stopServiceIfNeed(stop: Boolean)
```

## OpenVPNConfig (data class, Parcelable, implements IVpnConfiguration)
```kotlin
OpenVPNConfig(
    name: String? = null, host: String? = null, port: Int? = null,
    type: String? = null,                 // "tcp-client" / "udp-client" / "tcp-server"...
    cipher: String? = null, auth: String? = null,
    ca: String? = null, key: String? = null, cert: String? = null,
    tlsCrypt: String? = null, configuration: String? = null  // raw config override
)
fun buildConfig(): String  // reconstructs a config from fields (used only when configuration==null)
```

## OpenVPNThreadv3 (engine runner; you normally don't touch it)
`OpenVPNThreadv3(IOpenVPNService, config)` → `run()` (blocking: setConfig → connect),
`stopVPN()`, `networkChange()`. Loads `System.loadLibrary("ovpn3")`.
tun_builder_establish() calls `mService.openTun().detachFd()`.

## ConnectionState enum (com.tim.basevpn.state.ConnectionState, Parcelable)
READYFORCONNECT, CONNECTED, CONNECTING, DISCONNECTED, DISCONNECTING,
PERMISSION_NOT_GRANTED, IDLE.

## How to inspect a closed-source Kotlin AAR (no sources jar)
```bash
curl -sS -o lib.aar https://repo1.maven.org/maven2/<g>/<a>/<v>/<a>-<v>.aar
unzip -p lib.aar classes.jar > classes.jar
javap -classpath classes.jar com.tim.openvpn.service.IOpenVPNService   # -p for privates
# Kotlin properties appear as methods getX()/setX() in javap; use -s for signatures
```
Sources jar sometimes exists: `<a>-<v>-sources.jar` (this lib ships partial .kt sources).
