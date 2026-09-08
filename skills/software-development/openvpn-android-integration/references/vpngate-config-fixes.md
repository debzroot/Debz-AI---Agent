# VPN Gate config transformation + server behavior

## API
- Endpoint: `https://www.vpngate.net/api/iphone/` (also `vpngate.net/api/iphone/` redirects). ~1.3 MB CSV.
- Format: first line `*vpn_servers`, header line starts `#`, footer line starts `*`.
- Columns (15): HostName, IP, Score, Ping, Speed, CountryLong, CountryShort, NumVpnSessions, Uptime, TotalUsers, TotalTraffic, LogType, Operator, Message, **OpenVPN_ConfigData_Base64**.
- **Parse rule**: `line.split(",", limit = 15)` — the Message field can contain commas, so unlimited split breaks column alignment. Config base64 is `parts[14]`.
- Configs are SoftEther-generated: contain `remote <ip> <port>`, `<ca>/<cert>/<key>` blocks, `cipher AES-128-CBC` (legacy), no `<tls-crypt>`.
- Stream parse line-by-line for fast first-paint; cache raw text to `filesDir` so the list shows instantly on next launch.

## Config transformation recipe (applied to every fetched config)
```kotlin
val cleanLines = config.lines().filter { line ->
    val t = line.trim().lowercase()
    !t.startsWith("cipher ") &&
    !t.startsWith("data-ciphers ") &&
    !t.startsWith("keysize ") &&
    !t.startsWith("connect-retry")
}
val final = cleanLines.joinToString("\n").trimEnd() +
    "\ndhcp-option DNS 1.1.1.1\ndhcp-option DNS 8.8.8.8\n" +
    "cipher CHACHA20-POLY1305\n" +
    "data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM\n" +
    "remote-cert-tls server\n" +
    "connect-retry 1 1\n" +
    "connect-retry-max 1\n" +
    "block-ipv6\n" +
    "auth-user-pass\n"
```
Why each line:
- strip + `cipher CHACHA20-POLY1305` / `data-ciphers CHACHA20-POLY1305:...` — OpenVPN3 core rejects CBC for data channel ("bad cipher for data channel use"); ChaCha20 first because SoftEther servers have an AES-GCM bug (`DECRYPT_ERROR`).
- `block-ipv6` — most servers don't push IPv6 correctly; without it Android hangs on IPv6 resolution ("connected but no internet").
- `auth-user-pass` + `provide_creds()` override returning vpn/vpn — some servers require auth.
- `connect-retry-max 1` — stop the engine's internal infinite reconnect loop; let app-level auto-failover pick the next server instead.
- `remote-cert-tls server` — stable handshake.

## Server state semantics (from engine log lines)
| Log line | Meaning | Action |
|---|---|---|
| `AUTH_FAILED` | Server FULL (max users), not bad credentials | Mark dead, failover |
| `Session invalidated: DECRYPT_ERROR` | Server broken (SoftEther GCM bug) | Stop engine, failover |
| `Session invalidated: KEEPALIVE_TIMEOUT` | Server died mid-session (normal for free gate) | Failover / reconnect |
| `Transport Error: ... Connection refused` | Server down | Failover |
| `Server poll timeout` | No response | Failover |

## Usability patterns for free VPN Gate servers
- **Health check before connect**: TCP connect to `ip:port` (~1.2s timeout) filters dead hosts; hide them from the list.
- **Auto-failover**: on any terminal failure mark host dead and try the next server (1–1.5s delay); stop when user cancels — re-check the cancel flag AFTER the delay.
- **Refresh = full reset** of the list (dead servers disappear), not append.
- **Timeout watchdog**: only fire if state != CONNECTED (engine thread stays alive during a live session).
- Free servers drop sessions every few minutes to hours — that's the source, not the app; auto-reconnect is a feature request, not a bug.
