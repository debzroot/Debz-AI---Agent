# VPN Gate free servers — sourcing, parsing, sanitizing

Free public OpenVPN config source used by many "random country" VPN apps (incl. OvpnSpider-style apps). No account, no API key.

## API

```
GET https://www.vpngate.net/api/iphone/
```
- Plain CSV text (NOT JSON), ~1.3 MB full response with ~100-400 servers.
- Header row starts with `#`, footer row starts with `*` (skip both).
- 15 columns; **config base64 is column 14 (last)**. Message field can contain commas → split with `limit = 15`.
- Columns: HostName, IP, Score, Ping, Speed(byte/s), CountryLong, CountryShort, NumVpnSessions, Uptime, TotalUsers, TotalTraffic, LogType, Operator, Message, OpenVPN_ConfigData_Base64.
- Stream-parse line-by-line (OkHttp `source.readUtf8Line()`) and push chunks (~6) to the UI as they arrive; cache the raw text to `filesDir` for instant first paint next launch.
- Pick healthy servers: `score > 0 && ping > 0`, sort by score desc, random among top ~60%.

## Server failure signatures (log patterns)

| Log line | Meaning | Action |
|---|---|---|
| `AUTH_FAILED` | server at max users | skip → next server |
| `Session invalidated: DECRYPT_ERROR` | broken SoftEther data channel (GCM bug) | stop engine immediately → next server |
| `Transport Error: ... Connection refused` / `No route to host` | server down | skip → next server |
| `bad cipher for data channel use` | config still forces CBC | strip cipher lines (see below) |
| `Client terminated, restarting in 2000 ms...` | core auto-restart loop | only avoidable by stopping engine on the fatal errors above |

Free servers are a lottery: expect many dead/full/broken. Auto-failover scanning (next server, ~1.5 s pause, dead-server skip list) is mandatory, plus a manual/auto refresh of the list (~5 min).

## Config sanitization (must-run on every downloaded config)

The engine (OpenVPN3 core) rejects legacy options; sanitize BEFORE handing to engine:

1. **Strip** every line starting (case-insensitive) with: `cipher `, `data-ciphers `, `keysize `, `connect-retry`. Use a line filter, not regex-replace — configs vary in whitespace/case and leftover lines get "Unsupported option (ignored)" or worse.
2. **Inject**:
   ```
   cipher CHACHA20-POLY1305
   data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
   remote-cert-tls server
   connect-retry 1 1
   connect-retry-max 1
   block-ipv6
   dhcp-option DNS 1.1.1.1
   dhcp-option DNS 8.8.8.8
   ```
   - ChaCha20 FIRST: several SoftEther servers have an AES-GCM DECRYPT_ERROR bug.
   - `connect-retry-max 1` limits core's internal loop so app-level failover takes over.
   - `block-ipv6` prevents Android hanging on IPv6 (servers rarely push usable v6).
3. Parse `remote <host> <port>` and `proto <tcp|udp>` for the profile display. VPN Gate configs are overwhelmingly TCP (443/995/1194/1400+); UDP 1194 is often blocked/timeout — TCP-only is the pragmatic default.

## Note on sources

OvpnSpider-class apps use the same VPN Gate API + aggregated free config sources. The differentiator is fast skip/failover of dead servers and correct routing, not the source itself.
