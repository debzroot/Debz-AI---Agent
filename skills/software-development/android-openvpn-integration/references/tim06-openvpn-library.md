# tim06 OpenVPN Library — Verified API Surface

Verified via `javap` on `io.github.tim06:openvpn:1.1.3` and `io.github.tim06:basevpnprotocols:1.1.1` (Maven Central AARs) and the library's own sources jar.

## Dependency graph

```
io.github.tim06:openvpn:1.1.3
├── io.github.tim06:basevpnprotocols:1.1.0  (pin 1.1.1)
├── io.github.tim06:vpnprotocolsnotification:1.1.0  (com.tim.notification.* classes)
├── kotlin-stdlib / kotlin-parcelize-runtime 1.9.24
├── appcompat 1.5.0, lifecycle-runtime-ktx 2.8.2, kotlinx-coroutines-core 1.6.4
```

`com.tim.notification.DefaultVpnServiceNotification` lives in the THIRD artifact (`vpnprotocolsnotification`) — it's not in either AAR you'd guess first.

## Key classes

| Class | Notes |
|---|---|
| `com.tim.openvpn.OpenVPNThreadv3` | public, NOT final. extends `net.openvpn.ovpn3.ClientAPI_OpenVPNClient` implements `OpenVPNManagement` (stopVPN/networkChange/sendCRResponse/reconnect). Ctor `(IOpenVPNService, String config)`. Run in its own thread. |
| `com.tim.openvpn.OpenVPNConfigParser` | **BUGGY** — `linesByKey()` crashes with `fromIndex = -1` when `<tls-crypt>` absent. Bypass: build `OpenVPNConfig` manually with `configuration` = raw text. |
| `com.tim.openvpn.configuration.OpenVPNConfig` | Parcelable data class: name, host, port, type, cipher, auth, ca, key, cert, tlsCrypt, configuration. `buildConfig()` regenerates from parts — only used when `configuration == null`. |
| `com.tim.openvpn.service.OpenVPNService` | final service in AAR; extends `com.tim.basevpn.singleProcess.ProtocolsVpnService`. `Companion.startService(ctx, config, notificationClass?, allowedApps?)` and `Companion.stopService(ctx)` build the correct intent. |
| `com.tim.openvpn.service.IOpenVPNService` | Kotlin interface — **nullable params + properties** (see SKILL.md pitfall #4). |
| `com.tim.openvpn.model.CIDRIP` | `CIDRIP(String, int)` public; `CIDRIP(String, String)` internal. |
| `com.tim.basevpn.connection.VpnServiceConnection` | abstract; ctor `(Context, Class<out Service>, ((ConnectionState)->Unit)?, CoroutineScope)`. **`start(config,…)` drops the config** — bug. |
| `com.tim.basevpn.state.ConnectionState` | Enum: READYFORCONNECT, CONNECTED, CONNECTING, DISCONNECTED, DISCONNECTING, PERMISSION_NOT_GRANTED, IDLE. Parcelable. |
| `com.tim.basevpn.IVPNService` | AIDL: startVPN(), stopVPN(), getState(), registerCallback/unregisterCallback(IConnectionStateListener). |
| `net.openvpn.ovpn3.*` | SWIG wrappers: `ClientAPI_OpenVPNClient` (connect/stop/event/log/eval_config), `ClientAPI_LogInfo.getText()`, `ClientAPI_Event` (name/info/error/fatal), `ClientAPI_Status` (error/status/message), `ClientAPI_Config`, `ClientAPI_EvalConfig`. |

## Engine event → state mapping (from OpenVPNThreadv3.event)

- RESOLVE / WAIT / RECONNECTING / CONNECTING / GET_CONFIG / ASSIGN_IP → `ConnectionState.CONNECTING`
- CONNECTED → `ConnectionState.CONNECTED`
- DISCONNECTED → `ConnectionState.DISCONNECTED`
- INFO with `OPEN_URL:` / `CR_TEXT:` / `WEB_AUTH:` → `trigger_sso()`

Note: `ASSIGN_IP` maps to CONNECTING, so the Android key icon can appear (tunnel up) while state still says Connecting — don't treat the key icon as connected.

## Two valid integration shapes

**A. Use the AAR's own service (process `:openvpn`)**
1. Build `OpenVPNConfig` manually (never via parser).
2. `OpenVPNService.Companion.startService(ctx, cfg)` — delivers config via intent `CONFIGURATION_KEY`.
3. Bind for state: `IVPNService.Stub.asInterface(binder)`, `registerCallback(ConnectionListener)`.
4. Manifest: service with `foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn` + `BIND_VPN_SERVICE`.

**B. Run the engine in-process (own VpnService implementation)**
1. Your `VpnService` implements `IOpenVPNService` (watch nullable signatures + property overrides).
2. `VpnController.runEngine` constructs `OpenVPNThreadv3(serviceStub, config)` inside a worker thread.
3. Assign `management = thread` BEFORE `thread.start()`; stop via `(management as? OpenVPNThreadv3)?.stopVPN()` — interrupt() alone never stops native connect.
4. Wrap in `withTimeout(20s)` for the stuck-connecting watchdog.

## Stop semantics

- `OpenVPNThreadv3.stop()` → `super.stop()` + `mHandlerThread.quit()` + `mService.openvpnStopped()` (notification cleanup + state reset). `stopVPN()` posts stop to the handler thread — call it, then interrupt the engine thread.
- `onDestroy()` of the AAR service checks process name for `:openvpn` and calls `exitProcess(0)` — the service is designed to live in its own process.
