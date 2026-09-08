# VPN Gate API (vpngate.net) — Reference

## Endpoint
```
GET https://www.vpngate.net/api/iphone/
```
- No API key, no auth, completely free
- Response: plain CSV text, ~1.3 MB, typically 30-60s to download
- First line: `*vpn_servers`
- Second line: header `#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64`
- Footer line starts with `*`
- **15 columns**; config base64 is column 15 (index 14)
- Message field (column 13) CAN contain commas → use `split(",", limit=15)`

## Sample Row (truncated)
```
public-vpn-100,219.100.37.57,2943556,15,215202339,Japan,JP,170,6547169596,24677054,1856883008958144,2weeks,Daiyuu Nobori_ Japan. Acad,<base64 config>
```

## Columns
| Index | Name | Example |
|-------|------|---------|
| 0 | HostName | public-vpn-100 |
| 1 | IP | 219.100.37.57 |
| 2 | Score | 2943556 |
| 3 | Ping (ms) | 15 |
| 4 | Speed (bytes/sec) | 215202339 |
| 5 | CountryLong | Japan |
| 6 | CountryShort | JP |
| 7 | NumVpnSessions | 170 |
| 8 | Uptime (sec) | 6547169596 |
| 9 | TotalUsers | 24677054 |
| 10 | TotalTraffic (bytes) | 1856883008958144 |
| 11 | LogType | 2weeks |
| 12 | Operator | Daiyuu Nobori_ Japan. Acad |
| 13 | Message | (can be empty or contain commas) |
| 14 | OpenVPN_ConfigData_Base64 | <base64> |

## Decoding
```kotlin
val configText = String(Base64.decode(base64Column, Base64.DEFAULT), Charsets.UTF_8)
```

## Rate/Behavior
- No documented rate limit
- Download can be slow (30-60s)
- Recommended: stream parsing (line-by-line), push chunks to UI, cache raw text to `context.filesDir` ("servers_cache.txt") for instant next-launch display, refresh in background
- Set generous timeouts: connect 20s, read 60s+

## Typical Server Distribution (observed 2026-08)
- Japan (JP): ~40 servers
- Korea (KR): ~10
- Thailand (TH): ~5
- Russia (RU): ~4
- Plus US, DE, FR, etc. (full list ~150 servers, ~20 countries)

## Streaming fetch (list appears server-by-server, no long blank spinner)
Use OkHttp `Response.body!!.source().readUtf8Line()` in a loop: parse each line, batch ~6 servers, hop to `Dispatchers.Main` to append to a `mutableStateListOf`. Also accumulate raw text and cache to `context.filesDir` — app start loads cache instantly, refresh runs in background.

```kotlin
suspend fun streamServers(context: Context, onChunk: (List<VpnServer>) -> Unit) = withContext(Dispatchers.IO) {
    val request = Request.Builder().url(URL).header("User-Agent", "Mozilla/5.0 (Linux; Android 13) DebNetPlus/0.1").build()
    client.newCall(request).execute().use { resp ->
        if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}")
        val source = resp.body!!.source()
        val raw = StringBuilder()
        val chunk = mutableListOf<VpnServer>()

        while (true) {
            val line = source.readUtf8Line() ?: break
            raw.append(line).append('\n')
            parseLine(line)?.let { s ->
                chunk += s
                if (chunk.size >= CHUNK_SIZE) {
                    val batch = chunk.toList()
                    chunk.clear()
                    withContext(Dispatchers.Main) { onChunk(batch) }
                }
            }
        }
        if (chunk.isNotEmpty()) withContext(Dispatchers.Main) { onChunk(chunk.toList()) }

        context.openFileOutput(CACHE_FILE, Context.MODE_PRIVATE).use { it.write(raw.toString().toByteArray()) }
    }
}
```

## Config content (decoded base64)
- `dev tun`, `proto tcp`, `remote <IP> <port>` (443 etc.), `cipher AES-128-CBC`, `data-ciphers AES-128-CBC`, `auth SHA1`, `client`, `verb 3`, embedded `<ca>`, `<cert>`, `<key>` blocks.
- **No** `auth-user-pass` — no credentials needed.
- **No** `<tls-crypt>` block — this is what crashes tim06's OpenVPNConfigParser (it looks for `<tls-crypt>` unconditionally → `fromIndex = -1`).
- Construct `OpenVPNConfig(host=<remote IP>, port=<port>, type="tcp-client", configuration=<full raw config>)` and pass that to the service — engine gets the untouched raw config.

## Random-country generation UX
Pick server: `pool = servers.filter { country == null || it.countryShort == country }`, then `pool.random()`. Country dropdown should list ALL servers' countries (distinct + sorted), not just the currently filtered subset.

## Rate/Behavior
- No documented rate limit
- Download can be slow (30-60s)
- Recommended: stream parsing (line-by-line), push chunks to UI, cache raw text to `context.filesDir` ("servers_cache.txt") for instant next-launch display, refresh in background
- Set generous timeouts: connect 20s, read 60s+

## Typical Server Distribution (observed 2026-08)
- Japan (JP): ~40 servers
- Korea (KR): ~10
- Thailand (TH): ~5
- Russia (RU): ~4
- Plus US, DE, FR, etc. (full list ~150 servers, ~20 countries)