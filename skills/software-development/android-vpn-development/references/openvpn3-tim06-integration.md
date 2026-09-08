# OpenVPN3 Android Integration — tim06 Library Quirks

Library: `io.github.tim06:openvpn:1.1.3` (fork of ics-openvpn, published to Maven Central) + transitive `io.github.tim06:basevpnprotocols` and `io.github.tim06:vpnprotocolsnotification`.

## Key classes (verified via javap/source jars)

- `com.tim.openvpn.OpenVPNThreadv3(IOpenVPNService, String config)` — public, NOT final. Runs the native ovpn3 client. Constructor takes the raw config string.
- `com.tim.openvpn.service.IOpenVPNService` — Kotlin interface, **nullable param types** (`addDNS(dns: String?)`, `addRoute(route: CIDRIP?, ...)`, `override val ctResolver: ContentResolver?`, `override val connectivityManager: ConnectivityManager?`). Implement with nullable signatures or every method "overrides nothing".
- `com.tim.openvpn.model.CIDRIP(ip, prefixInt)` — public. The `(String, String)` mask constructor is **internal**; convert masks manually.
- `net.openvpn.ovpn3.ClientAPI_*` — SWIG-generated OpenVPN3 API (event, log, status, provide_creds, tun_builder_*).

## Bugs in the library (work around them)

1. **`VpnServiceConnection.start(config, ...)` DROPS the config.** The `config` param is accepted then discarded — only `bindService` + `startVPN()` run. The service then hits `requireNotNull(config)` → throw → silent dead connect. **Never use VpnServiceConnection to deliver config.** Deliver via intent extra `CONFIGURATION_KEY` with `ACTION_START` (the `Companion.startService` path), or run the engine directly in-process (the pattern in the umbrella SKILL.md).
2. **`OpenVPNConfigParser.parse()` crashes with `fromIndex = -1`** on VPN Gate configs: `linesByKey("<tls-crypt>")` does `subList(-1, 0)` when the block is absent. **Don't use it.** Build your own profile object / pass raw config string.
3. **`OpenVPNLogger` is dead in the AAR** (`BuildConfig.DEBUG=false`) — all engine logs silently swallowed. This is why you must override `log()` in your own `OpenVPNThreadv3` subclass.
4. **`ClientAPI_OpenVPNClient` constructor is protected** — you cannot instantiate it directly; subclass `OpenVPNThreadv3` instead.

## Observability pattern (the thing that unblocked everything)

```kotlin
val thread = object : OpenVPNThreadv3(serviceStub, config.config) {
    override fun log(info: ClientAPI_LogInfo?) { /* push to StateFlow + file */ }
    override fun event(e: ClientAPI_Event?) {
        // log it, detect AUTH_FAILED/DECRYPT_ERROR/KEEPALIVE_TIMEOUT...
        super.event(e)   // ← MANDATORY: maps EVT → ConnectionState → UI
    }
    override fun connect(): ClientAPI_Status {
        val st = super.connect()
        if (st.error) report("${st.status}: ${st.message}")
        return st
    }
    override fun provide_creds(creds: ClientAPI_ProvideCreds?) {
        creds?.setUsername("vpn"); creds?.setPassword("vpn")  // VPN Gate default creds
    }
}
```

State event names the engine emits: `RESOLVE/WAIT/RECONNECTING/CONNECTING/GET_CONFIG/ASSIGN_IP` → CONNECTING; `CONNECTED`; `DISCONNECTED`; `AUTH_FAILED`.

## Lifecycle rules

- Keep a reference to the engine instance (`management = thread`) **before** `Thread{...}.start()` — cancel/stop calls `(management as? OpenVPNThreadv3)?.stopVPN()` which is the only thing that stops the native connect (plain `Thread.interrupt()` does NOT stop native code).
- `connect-retry-max 1` in config stops the engine's internal reconnect loop so YOUR failover logic (not the engine) decides the next server.
