# VPN Gate + OpenVPN3 Engine Integration

## VPN Gate API (`https://www.vpngate.net/api/iphone/`)

- Plain text CSV, 15 columns, `#` header line, `*` footer line.
- Columns: `HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64`
- OpenVPN config is **base64 in column 14** (index 14 when splitting with limit 15 — Message field can contain commas).
- Stream with `OkHttp` `resp.body!!.source().readUtf8Line()` and parse each line into a `VpnServer` batch so the list populates incrementally (scale-in animation) instead of blocking on the full ~1.3MB download.
- Configs are anonymous-access: no credentials. If a config demands auth, `provide_creds()` → username `vpn`, password `vpn`.

## Error-code semantics (learned the hard way)

| Log line | Meaning | App action |
|---|---|---|
| `EVT AUTH_FAILED` | Server at max user capacity (NOT bad credentials) | Skip server, failover next |
| `Session invalidated: DECRYPT_ERROR` | Server broken (SoftEther data-channel bug) | STOP engine immediately → failover |
| `Session invalidated: KEEPALIVE_TIMEOUT` | Server died / stopped responding | STOP engine immediately → failover |
| `Client exception in transport_recv: crypto_alg: AES-128-CBC: bad cipher` | OpenVPN3 core rejects CBC data channel | Rewrite cipher lines to modern AEAD |
| `Server poll timeout` | TCP connect never answered | Let 20s timeout fire → failover |

## OpenVPN3 cipher saga

- VPN Gate configs are ancient: `cipher AES-128-CBC`, `keysize 128`, `auth SHA1`.
- OpenVPN3 (tim06 AAR) **hard-rejects AES-128-CBC for the data channel** — handshake/TUN succeeds, then immediate loop of `bad cipher for data channel use`.
- Appending `data-ciphers ...` does NOT help — server still pushes CBC and the client honors the pushed cipher.
- Working fix: **strip every `cipher` / `data-ciphers` / `keysize` / `connect-retry` line** (case-insensitive prefix filter) then append:
  ```
  cipher CHACHA20-POLY1305
  data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
  remote-cert-tls server
  connect-retry 1 1
  connect-retry-max 1
  block-ipv6
  auth-user-pass
  dhcp-option DNS 1.1.1.1
  dhcp-option DNS 8.8.8.8
  ```
- CHACHA20-POLY1305 first: some SoftEther builds have an AES-GCM bug → `DECRYPT_ERROR` even with GCM. ChaCha is least affected.

## Engine callback contract (`io.github.tim06:openvpn` AAR)

- `OpenVPNThreadv3(IOpenVPNService, config)` is **public & subclassable** (not final) — subclass it to intercept `log()`, `event()`, `connect()`, `provide_creds()`.
- **`super.event(e)` is MANDATORY** — base maps EVT names (CONNECTING/CONNECTED/DISCONNECTED) → `updateStateThread()` → your UI state. Skipping super = UI frozen on "Connecting…" while tunnel works.
- `IOpenVPNService` is a Kotlin interface: nullable params (`dns: String?`) and Kotlin properties (`val connectivityManager`). Verify with `javap -s` on the AAR classes.jar before writing overrides — mismatches cause "overrides nothing" / "Conflicting overloads".
- Do NOT implement both `IOpenVPNService` and your own `EngineCallback` on the same class — same method names (`setMtu`, `openTun`, `protectFd`) = conflicting overloads. Implement ONE, wrap the other.
- Engine runs on its own thread; `interrupt()` does NOT stop native connect. To cancel: keep a reference to the `OpenVPNThreadv3` instance **before** starting the thread (race: assigning inside the thread means `stopVPN()` sees null) and call `.stopVPN()`.
- `BuildConfig.DEBUG` is false in release AARs → the library's own logger is silent. Your subclass overrides are the ONLY way to see engine logs.

## TUN setup in the VpnService

- Do NOT pre-add addresses/routes/DNS in the VpnService `Builder` — the engine adds the server-pushed IP via callbacks (`setLocalIP`, `addRoute`, `addDNS`). A hardcoded `addAddress("10.111.0.2", 24)` collides with the pushed `/30` → "connected but zero internet".
- Set only `setSession(name)`, `setMtu(1500)`, `setBlocking(true)`.
- `block-ipv6` config directive stops Android hanging on IPv6 lookups for servers that don't push v6.

## Health check + server list

- TCP connect test (`Socket().connect(InetSocketAddress(host,port), 1200)`) is a cheap liveness probe; run in parallel batches (chunk of 6) on `Dispatchers.IO`.
- **CRITICAL**: skip fetch + health-check entirely while CONNECTING/CONNECTED — socket tests through the active tunnel hammer it → KEEPALIVE_TIMEOUT → self-DC after ~20 min. Read `StateFlow.value` fresh inside the coroutine (stale closure from composition re-runs it).
