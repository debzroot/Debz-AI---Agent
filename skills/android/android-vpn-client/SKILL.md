---
name: android-vpn-client
description: Build Android VPN apps with OpenVPN3 engine and VpnService.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn3, kotlin, vpn-service, vpngate]
    category: android
---

# Android VPN Client Development with OpenVPN3

## When to Use
Use when building an Android VPN client app that:
- Connects to VPN servers using OpenVPN protocol
- Needs to integrate OpenVPN3 engine (via io.github.tim06:openvpn library)
- Requires proper VpnService permission flow
- Wants to capture engine logs/events for debugging

## Core Architecture

### 1. VpnService Implementation
```kotlin
class DebOpenVpnService : VpnService(), EngineCallback {
    // Implement EngineCallback (NOT IOpenVPNService - causes overload conflicts)
    // Use Builder() for tun setup
    // startForeground() with proper notification channel
    // runEngine() via VpnController
}
```

### 2. EngineCallback Interface
```kotlin
interface EngineCallback {
    fun setMtu(mtu: Int)
    fun addDNS(server: String)
    fun addRoute(cidrip: CIDRIP, include: Boolean)
    fun addRoute(dest: String, prefix: Int, gateway: String?, device: String?)
    fun addRoutev6(ip: String, prefix: Int)
    fun setDomain(domain: String)
    fun setLocalIP(cidrip: CIDRIP)
    fun setLocalIPv6(ip: String)
    fun protectFd(fd: Int): Boolean
    fun openTun(): ParcelFileDescriptor?
    fun onStateChanged(state: ConnectionState)
    fun onEngineLog(line: String)
    fun onEngineError(msg: String)
    fun onThreadFinished()
}
```

### 3. VpnController.runEngine()
```kotlin
fun runEngine(config: VpnProfile, callback: EngineCallback) {
    val serviceStub = object : IOpenVPNService {
        // Delegate all methods to callback
    }
    
    val thread = object : OpenVPNThreadv3(serviceStub, config.config) {
        override fun log(info: ClientAPI_LogInfo?) { /* capture logs */ }
        override fun event(e: ClientAPI_Event?) { /* capture events, map to state */ }
        override fun connect(): ClientAPI_Status { /* capture connect errors */ }
    }
    thread.run()
}
```

## Permission Flow (Critical)
```kotlin
// In Activity:
val prepared = VpnService.prepare(this)
if (prepared != null) {
    vpnPermissionLauncher.launch(prepared) // Shows system dialog
} else {
    vpnService?.startVpn(config) // Already granted
}
```
**Never call VpnService.prepare() from Service** - must be from Activity context.

## Common Pitfalls & Fixes

| Issue | Fix |
|-------|-----|
| `setMtu/protectFd/openTun` overload conflicts | **Don't implement IOpenVPNService** - only extend VpnService + implement EngineCallback |
| Duplicate `startVpn/stopVpn` methods | Define once in class body, not repeated at end |
| StateFlow assignment fails | Use `fun setConfig(profile: VpnProfile?)` instead of `.value =` on read-only StateFlow |
| Engine logs not visible | Release AAR disables OpenVPNLogger - must override `log()` and `event()` in OpenVPNThreadv3 subclass |
| `VpnService.prepare()` returns null but not connected | Bind service first, then call prepare() after bind |
| Connection stuck on "Connecting..." | Add 20s timeout + fallback to UDP 1194 (SoftEther/VPN Gate always supports UDP) |

## Retry Strategy (VPN Gate / SoftEther)
```kotlin
// Attempt 1: TCP 443 (default)
// Attempt 2: UDP 1194 (change proto to "udp-client", port 1194)
// Always add DNS fallback:
"dhcp-option DNS 1.1.1.1\ndhcp-option DNS 8.8.8.8"
```

## Timeout Handling
```kotlin
timeoutJob = scope.launch {
    delay(20_000)
    if (state != ConnectionState.CONNECTED) {
        reportError("Server penuh/lambat")
        stopEngine()
    }
}
```

## Key Dependencies
```kotlin
implementation("io.github.tim06:openvpn:1.1.3")
implementation("io.github.tim06:basevpnprotocols:1.1.1")
```

## Project Structure
```
app/
├── src/main/java/com/.../
│   ├── VpnController.kt       # Engine runner + state management
│   ├── DebOpenVpnService.kt   # VpnService + EngineCallback impl
│   ├── MainActivity.kt        # Permission flow + UI connection
│   ├── data/VpnGateApi.kt     # VPN Gate server fetching
│   └── ui/DebNetApp.kt        # Compose UI with connection overlay
└── AndroidManifest.xml        # VpnService declaration + permissions
```

## AndroidManifest.xml Template
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />

<application>
    <service
        android:name=".vpn.DebOpenVpnService"
        android:permission="android.permission.BIND_VPN_SERVICE"
        android:exported="false">
        <intent-filter>
            <action android:name="android.net.VpnService" />
        </intent-filter>
    </service>
</application>
```

## Testing Checklist
- [ ] Permission dialog appears on first connect
- [ ] Icon key appears in status bar (tunnel created)
- [ ] Connection state moves: CONNECTING → CONNECTED
- [ ] Engine logs appear in UI overlay
- [ ] Timeout triggers after 20s if stuck
- [ ] Cancel button stops connection cleanly
- [ ] Retry switches to UDP 1194
- [ ] Disconnect removes icon key immediately