# VPN Gate Connect Failures — Verbatim Log Signatures

Real transcripts from debugging DebNet+ (OpenVPN3 via io.github.tim06:openvpn 1.1.3, VPN Gate servers).
Each block is a distinct failure mode; match the log lines to diagnose quickly.

---

## 1. CBC cipher rejection → infinite reconnect loop

```
Connected via tun
Client exception in transport_recv: crypto_alg: AES-128-CBC: bad cipher for data channel use
Client terminated, restarting in 2000 ms...
EVT RECONNECTING
... (repeats) ...
AUTH_FAILED
EVT AUTH_FAILED
EVT DISCONNECTED
```

**Cause:** config still carries `cipher AES-128-CBC` / `data-ciphers ...AES-128-CBC` (VPN Gate's SoftEther default). OpenVPN3 core refuses CBC for the data channel.
**Fix:** strip ALL `cipher`/`data-ciphers`/`keysize` lines from the raw config, append `cipher CHACHA20-POLY1305` + `data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM`.

## 2. AES-GCM SoftEther bug → connected then dropped

```
EVT CONNECTED 211.19.76.182:1820 via /TCP on tun/10.211.1.117/ gw=[10.211.1.118/] mtu=(default)
Session invalidated: DECRYPT_ERROR
Client terminated, restarting in 2000 ms...
EVT RECONNECTING
```

**Cause:** some SoftEther servers corrupt AES-GCM data channels (known community issue).
**Fix:** prefer ChaCha20-POLY1305 first in data-ciphers; fail-fast on `DECRYPT_ERROR`/`Session invalidated` in the log callback and failover.

## 3. Server full → AUTH_FAILED

```
Session is ACTIVE
EVT GET_CONFIG
Sending PUSH_REQUEST to server...
AUTH_FAILED
EVT AUTH_FAILED
```

**Cause:** VPN Gate free servers cap concurrent users; this is NOT a credential problem (creds are empty by design).
**Fix:** treat as "server full" → mark dead, auto-failover. Same signature can appear after a few PUSH_REQUEST retries.

## 4. Server down → connection refused

```
Transport Error: TCP connect error on '60.153.248.204:1400' (60.153.248.204:1400): Connection refused
Client terminated, restarting in 2000 ms...
```

**Cause:** dead/unreachable server (or wrong port). VPN Gate list includes stale entries.
**Fix:** fail-fast on `Connection refused`, failover, auto-refresh list every ~5 min.

## 5. Healthy connection killed by app timeout (app bug, not server)

```
EVT CONNECTED 211.19.76.182:1820 ... via /TCP on tun/10.211.1.117/
STATE: CONNECTED
TIMEOUT 20s — cancelling engine
STATE: IDLE
ERROR: Server timeout (20s) — coba server lain
EVT DISCONNECTED
```

**Cause:** timeout loop keyed on `thread.isAlive` — engine thread stays alive during a healthy session.
**Fix:** loop `while (threadAlive && state != CONNECTED)`; only cancel when state is genuinely not CONNECTED.

## 6. UI stuck "Connecting…" while engine actually connected (app bug)

Log shows `EVT CONNECTED` and full tun setup, but UI never leaves Connecting and Cancel does nothing.
**Cause:** `event()` overridden for logging without `super.event(e)` → state events never reach `updateStateThread()` → UI.
**Fix:** always call `super.event(e)` at the end of the override.

## 7. Crash after Allow (pre-connection)

```
android.app.MissingForegroundServiceTypeException: Starting FGS without a type callerApp=... targetSDK=34
at android.app.Service.startForeground(Service.java:775)
```

**Cause:** manifest service lacks `android:foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn`.
**Fix:** add both (see SKILL.md section 5).

## 8. Parser crash `fromIndex = -1`

`OpenVPNConfigParser.linesByKey("<tls-crypt>")` → `indexOfFirst` returns -1 because VPN Gate configs have no `<tls-crypt>` block → slice(-1..0) crash.
**Fix:** never use the parser; build `OpenVPNConfig(host, port, type)` manually and set `configuration = rawConfigText` (engine uses it verbatim via `conf.configuration ?: conf.buildConfig()`).
