# tim06 OpenVPN library quirks (io.github.tim06:openvpn:1.1.3)

Decompiled via `javap -p -classpath classes.jar` on the AAR's classes.jar
(extract with `unzip -p openvpn.aar classes.jar > classes.jar`). Sources jar
(`-sources.jar`) exists for `com.tim.*` but is missing some files (e.g.
`IOpenVPNService` only exists as bytecode). `jdk-headless` provides javap.

## Artifacts
- `io.github.tim06:openvpn:1.1.3` — engine + service classes (com.tim.openvpn.*)
- `io.github.tim06:basevpnprotocols:1.1.1` — state machine, AIDL, connection helpers (pin this version explicitly; the transitive 1.1.0 differs)
- `io.github.tim06:vpnprotocolsnotification` — `com.tim.notification.*` (transitive; not always visible in the AAR listing)

## Key API facts
- `OpenVPNThreadv3(IOpenVPNService, String config)` — public constructor, **not final** → subclass to capture logs/events.
- `ClientAPI_OpenVPNClient` (the SWIG native client) has a **protected** constructor → cannot be instantiated directly; go through `OpenVPNThreadv3`.
- `OpenVPNManagement` interface (tim06) has only: `stopVPN()`, `networkChange()`, `sendCRResponse()`, `reconnect()`.
- `IOpenVPNService` (Kotlin): methods take **nullable** params (`addDNS(dns: String?)`, `addRoute(dest: String?, mask: String?, ...)`, `openTun(): ParcelFileDescriptor?`, `trigger_sso(url: String?)`, `updateStateThread(ConnectionState)`, `openvpnStopped()`); properties `ctResolver`, `connectivityManager` are **Kotlin properties** (override as `override val`, not `fun`). Overriding with non-null signatures → "overrides nothing".
- `ConnectionState` enum: IDLE, READYFORCONNECT, CONNECTED, CONNECTING, DISCONNECTED, DISCONNECTING, PERMISSION_NOT_GRANTED (implements Parcelable).
- `CIDRIP(ip, prefixLen)` public; `CIDRIP(ip, maskString)` is **internal** — use the int-prefix ctor.

## Confirmed library bugs (workarounds mandatory)
1. **`VpnServiceConnection.start(config, ...)` never delivers config.** Its `start()` only does `bindService` + `getService()?.startVPN()`; the config param is dropped. The service's `prepare(intent)` reads the config from intent extra `CONFIGURATION_KEY` (`OpenVPNService.CONFIGURATION_KEY`). Workaround: start the service with an explicit Intent carrying `ACTION_KEY`/`ACTION_START_KEY` + `CONFIGURATION_KEY` (Parcelable `OpenVPNConfig`), and bind separately only for the state listener.
2. **`OpenVPNConfigParser.parse(config)` crashes with "fromIndex = -1"** on VPN Gate configs: `linesByKey("<tls-crypt>")` does `indexOfFirst` for a block that doesn't exist → returns -1 → `subList(-1, 0)` throws. Workaround: never use the parser; build `OpenVPNConfig(name, host, port, type, configuration = rawConfig)` manually. `OpenVPNService.startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()` — so raw config in `.configuration` is passed straight to the engine.
3. **`OpenVPNLogger` is dead in release AARs.** It logs only when `BuildConfig.DEBUG` — Maven artifacts are release builds → all engine logging silently swallowed. Subclass `OpenVPNThreadv3` and override `log()`, `event()`, `connect()` to capture (see SKILL.md pitfall 3: MUST call `super.event(e)`).
4. **`IntentActionVpnService.onStartCommand` requires a non-null intent** or throws IllegalArgumentException — always start via intent.

## AIDL surface (basevpnprotocols)
- `IVPNService`: `startVPN()`, `stopVPN()`, `getState()`, `registerCallback(IConnectionStateListener)`, `unregisterCallback(...)`.
- `IConnectionStateListener`: `stateChanged(ConnectionState)`, `trafficUpdate(txRate, rxRate, txTotal, rxTotal)`.
- `ConnectionListener` abstract class wraps the Stub: extend it, override the two methods.
- `VpnServiceConnection` is abstract but has no abstract members → can be instantiated as an anonymous object; it is the class with the config-dropping bug.

## Typical debugging flow that worked
1. Add a `LogSaver` (write engine logs to `filesDir/logs/`, share via FileProvider).
2. Subclass `OpenVPNThreadv3`, override `log`/`event`/`connect` → push to UI + file.
3. Map engine events manually in `event()` (RESOLVE/WAIT/CONNECTING/GET_CONFIG/ASSIGN_IP → CONNECTING; CONNECTED; DISCONNECTED) but ALSO call `super.event(e)` so the library's own state mapping still fires.
4. Watch for: `AUTH_FAILED` (server full), `DECRYPT_ERROR` (SoftEther GCM bug), `KEEPALIVE_TIMEOUT` (server died), "bad cipher for data channel use" (CBC stripped check), `Transport Error: ... Connection refused` (down).
