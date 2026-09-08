---
name: android-vpn-app
description: "Build Android VPN apps with OpenVPN3, VPN Gate, Android 14+."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, vpn, openvpn3, vpngate, kotlin, compose]
    category: android
---

# Android VPN App Development

Build VPN apps for Android using OpenVPN3 engine (via tim06 fork) with VPN Gate public servers.

## When to Use

- Building a personal VPN client for Android
- Integrating OpenVPN3 engine (tim06 fork) with VPN Gate public servers
- Need Android 14+ foreground service compliance
- Working with VPN Gate API (free public VPN servers)

## Core Architecture

```
DebNet+ (Kotlin + Jetpack Compose, Material3 dark)
├─ data/VpnGateApi          → fetch + parse server list from vpngate.net/api/iphone/
├─ vpn/DebOpenVpnService    → VpnService + EngineCallback (main process)
├─ VpnController            → Engine runner + StateFlow state management
└─ ui/DebNetApp             → Material3 dark UI: server list, country filter, connect overlay
```

## Key Integration Points

### 1. VPN Gate API (Free, No Auth)

```
Endpoint: https://www.vpngate.net/api/iphone/
Format: CSV with 15 columns, last column = base64 OpenVPN config
```

**Parser gotcha:** VPN Gate configs **don't have `<tls-crypt>`** — tim06's `OpenVPNConfigParser` crashes looking for it. **Solution:** bypass parser, construct `OpenVPNConfig` manually with raw config string.

### 2. OpenVPN3 Engine (tim06 fork)

**Library:** `io.github.tim06:openvpn:1.1.3` (Maven Central)

**Critical bugs in library:**
- `OpenVPNConfigParser` crashes on VPN Gate configs (expects `<tls-crypt>`)
- `OpenVPNLogger` silenced in release AAR (`BuildConfig.DEBUG=false`) → all engine errors silenced
- `VpnServiceConnection.start(config)` **drops config parameter** — config only delivered via intent extra `CONFIGURATION_KEY`

**Workarounds implemented:**
1. Bypass parser → construct `OpenVPNConfig` manually with raw config
2. Hook engine callbacks → capture logs/events/errors to UI via `EngineCallback`
4. Use `EngineCallback` interface for all VpnService callbacks

### 3. Engine Callback Interface

```kotlin
interface EngineCallback {
    val ctResolver: ContentResolver
    val connectivityManager: ConnectivityManager
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

### 4. VpnService Implementation (Main Process)

```kotlin
class DebOpenVpnService : VpnService(), EngineCallback {
    // Implement EngineCallback methods → delegate to builder
    // Run engine in separate thread with try/catch
}
```

### 5. Android 14+ Foreground Service Compliance

**Manifest:**
```xml
<service
    android:name=".vpn.DebOpenVpnService"
    android:permission="android.permission.BIND_VPN_SERVICE"
    android:exported="false"
    android:foregroundServiceType="specialUse">
    <intent-filter>
        <action android:name="android.net.VpnService" />
    </intent-filter>
    <property
        android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        android:value="vpn" />
</service>
```

**Permissions:**
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
```

### 6. VPN Gate Server Selection (TCP Only)

**VPN Gate reality:** Most free servers only support **TCP 443**. UDP 1194 often times out.

```kotlin
// Always use TCP, no UDP retry
fun buildVpnProfile(config: String, serverName: String): VpnProfile {
    // Parse host/port from config
    // Force proto = "tcp-client"
    // Add DNS fallback: dhcp-option DNS 1.1.1.1 / 8.8.8.8
}
```

**Server scoring:** Filter by `score > 0 && ping > 0`, pick from top 60% by score.

### 7. CIPHER FIX (mandatory — OpenVPN3 rejects CBC)

OpenVPN3 core (tim06) **rejects AES-128-CBC for the data channel**: `crypto_alg: AES-128-CBC: bad cipher for data channel use`. VPN Gate configs still carry CBC → endless reconnect loop. STRIP every `cipher`/`data-ciphers`/`keysize`/`connect-retry` line (case-insensitive, tolerate leading whitespace), then append:

```
cipher CHACHA20-POLY1305
data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
remote-cert-tls server
connect-retry 1 1
connect-retry-max 1
```

ChaCha20-POLY1305 FIRST: some SoftEther servers have an AES-GCM bug → `Session invalidated: DECRYPT_ERROR` loop right after `EVT CONNECTED`.

### 8. Known server-side failure modes (fail fast, don't wait for retry loop)

| Log signature | Meaning | Action |
|---------------|---------|--------|
| `AUTH_FAILED` | VPN Gate server FULL (max users) — NOT a credentials problem | Mark dead, auto-failover to next server |
| `DECRYPT_ERROR` / `Session invalidated` | SoftEther AES-GCM bug / broken server | Mark dead, failover |
| `Transport Error: TCP connect error ... Connection refused` | Server down | Mark dead, failover |
| `bad cipher for data channel use` | CBC not stripped from config | Fix cipher injection (section 7) |

Detect these strings in your `log()` override and trigger failover immediately instead of waiting for the engine's internal retry loop. Auto-failover: after a failure, skip dead servers, try next after ~1.5s delay, and RE-CHECK `userCancelled` after the delay (user may have pressed Cancel during the wait). Always leave a "Stop Failover" button visible in failed state.

### 7. Engine Thread Management

```kotlin
// Run engine in isolated thread with full error capture
val thread = object : OpenVPNThreadv3(serviceStub, config) {
    override fun log(info) { captureLog(info.text) }
    override fun event(e) { captureEvent(e); updateState(e) }
    override fun connect(): ClientAPI_Status {
        val st = super.connect()
        if (st.error) reportError(st)
        return st
    }
}
thread.run()
```

**Cancel logic (CORRECT — interrupt() alone is NOT enough):**
```kotlin
fun stopEngine() {
    // PENTING: interrupt() doesn't stop native connect() — must stopVPN() first.
    (management as? com.tim.openvpn.OpenVPNThreadv3)?.stopVPN()
    engineJob?.cancel()
    engineThread?.interrupt()
    engineThread = null
    setState(ConnectionState.IDLE)  // close overlay so Cancel visibly works
}
```
**CRITICAL race condition:** assign `management = thread` BEFORE starting the engine thread. If assigned inside the thread body, `stopVPN()` from the main thread finds null → Cancel button silently does nothing.

**State propagation (the #1 "stuck Connecting…" cause):**
When subclassing `OpenVPNThreadv3` and overriding `event()`, you MUST call `super.event(e)` at the end. The parent's `event()` maps engine events (CONNECTING/CONNECTED/DISCONNECTED) to `updateStateThread()` → UI. Overriding for logging without `super.event()` leaves the UI stuck on "Connecting…" forever even though the engine genuinely connected.

**Timeout must watch STATE, not thread liveness:**
The engine thread stays `isAlive` during a healthy session. A 20s timeout loop keyed on `thread.isAlive` will KILL a good connection right after `EVT CONNECTED` (symptom: "TIMEOUT 20s — cancelling engine" appears in the log AFTER CONNECTED). Loop `while (threadAlive && state != CONNECTED)` and only cancel when genuinely not connected.

**Don't implement both `IOpenVPNService` and a custom callback interface:**
Same-signature methods (`setMtu`, `protectFd`, `openTun`) cause Kotlin "Conflicting overloads" compile errors. Implement ONE interface; stub the other's methods as no-ops if a class signature forces both.

## Gradle Dependencies

```kotlin
dependencies {
    implementation("io.github.tim06:openvpn:1.1.3")
}
```

## Common Pitfalls & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| `MissingForegroundServiceTypeException` | Android 14+ requires `foregroundServiceType` | Add `android:foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn` |
| Parser crash `fromIndex = -1` | `OpenVPNConfigParser` looks for `<tls-crypt>` | Bypass parser, use raw config in `OpenVPNConfig.configuration` |
| Config not delivered | `VpnServiceConnection.start(config)` drops param | Start via intent with `CONFIGURATION_KEY` extra |
| Engine errors invisible | `OpenVPNLogger` uses `BuildConfig.DEBUG` (false in release) | Hook `log()`/`event()`/`connect()` in `OpenVPNThreadv3` subclass |
| Cancel button dead | Engine thread not interrupted | `management.stopVPN()` FIRST (interrupt alone won't stop native connect), set `management` BEFORE thread start |
| UI stuck "Connecting…" forever | Overrode `event()` without calling `super.event(e)` — state never reaches UI | Always end `event()` override with `super.event(e)` |
| Connection killed ~20s after CONNECTED | Timeout loop keyed on `thread.isAlive` (stays alive during healthy session) | Loop `while (alive && state != CONNECTED)`; only cancel when not connected |
| `crypto_alg: AES-128-CBC: bad cipher` loop | VPN Gate configs carry deprecated CBC | Strip all cipher lines, inject CHACHA20-POLY1305 (section 7) |
| `Session invalidated: DECRYPT_ERROR` | SoftEther AES-GCM bug | ChaCha20 first; fail-fast failover |
| `AUTH_FAILED` | VPN Gate server full | Failover to next server (not an auth bug) |
| Conflicting overloads compile error | Class implements both `IOpenVPNService` + custom callback interface | Implement ONE interface, stub the other no-op |
| UDP timeout / stuck | VPN Gate servers mostly TCP only (UDP 1194 often blocked) | Use TCP 443 only, no UDP retry |
| `Unresolved reference: BuildConfig` | AGP 8+ hides BuildConfig by default | `buildFeatures { buildConfig = true }` |
| `Val cannot be reassigned` | `StateFlow.value` is read-only | Expose `setConfig()` via `_config` MutableStateFlow |

## Debugging Workflow

- **LogSaver pattern**: append every engine log / state change / error to `filesDir/logs/debnet_<ts>.log`; add a "Share Logs" button (FileProvider + `ACTION_SEND` intent) so the user can send you the file. OpenVPN3 logs are extremely precise — one log file usually identifies the root cause immediately.
- **Stamp the version** in the log header AND the UI subtitle — users routinely install a stale APK artifact and report "still broken" when the fix is already in a newer build. Verify which build they have before debugging.
- **GitHub Actions builds**: debug APK artifact downloads can silently serve old builds; always tell the user to grab the TOP (latest green) run.