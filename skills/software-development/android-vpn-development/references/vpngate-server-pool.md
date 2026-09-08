# VPN Gate Free Server Pool — Reality & Strategy

Source: `https://www.vpngate.net/api/iphone/` (CSV). Columns (15): HostName, IP, Score, Ping, Speed, CountryLong, CountryShort, NumVpnSessions, Uptime, TotalUsers, TotalTraffic, LogType, Operator, Message, **OpenVPN_ConfigData_Base64** (last). Split with `limit=15` — the Message field contains commas. Skip rows starting `*` (footer) and `#` (header).

## Server failure taxonomy (from real logs — don't misdiagnose)

| Log signature | Meaning | App response |
|---|---|---|
| `AUTH_FAILED` right after PUSH_REQUEST | Server **full** (max users) — NOT bad credentials | mark dead, failover |
| `Connected via tun` then `Session invalidated: DECRYPT_ERROR` | Broken SoftEther data-channel (GCM bug) | stop engine fast, failover |
| `Session invalidated: KEEPALIVE_TIMEOUT` after minutes | Server stopped answering (or **Doze killed your keepalive** — see wakelock pitfall) | failover |
| `Transport Error: ... Connection refused / No route to host` | Server offline | mark dead, failover |
| `Server poll timeout` | Handshake stall | failover |

Server "live" (health check TCP-connect OK) ≠ usable (may be full/broken). Health check only removes obviously-dead servers; the connect loop still needs failover.

## Client config hardening (all applied in this project)

- `block-ipv6` — many servers push broken IPv6; Android waits on IPv6 → "connected but hangs".
- `dhcp-option DNS 1.1.1.1 / 8.8.8.8` — DNS fallback.
- `remote-cert-tls server` — TLS auth check.
- `auth-user-pass` + `provide_creds("vpn","vpn")` — VPN Gate's public default creds for servers that demand auth.
- Cipher block per umbrella pitfall #1.

## Failover design

- Refresh RESETS the server list (replace, not append) so dead servers disappear; show `alive/total` + last-updated timestamp.
- Health check: `Socket().connect(InetSocketAddress(ip, port), 1200)` per server, parallel batches of ~6. **Skip health check while connected** — socket probes through the tunnel add lag and can trigger keepalive timeouts.
- On any failure: add server to dead set, delay ~1.5s, try next. Re-check `userCancelled` AFTER the delay — user may have tapped cancel during the wait.
- Auto-refresh every 5 min; treat every connect attempt as a probe that can mark a server dead.
