# Template: sanitized OpenVPN config builder (Kotlin) for VPN Gate + OpenVPN3 engine
# Serves as the known-good config transform. Copy & adapt.

// Input: raw config from vpngate.net/api/iphone/ (base64 col 14, decoded)
// Output: config string the OpenVPN3 engine accepts.

fun buildSanitizedConfig(config: String, serverName: String, country: String? = null): VpnProfile {
    var host: String? = null
    var port: Int? = null
    var proto = "tcp-client"
    for (line in config.lines()) {
        val t = line.trim()
        if (t.startsWith("remote ") && !t.startsWith(";") && !t.startsWith("#")) {
            val parts = t.split(Regex("\\s+"))
            host = parts.getOrNull(1)
            port = parts.getOrNull(2)?.toIntOrNull()
        } else if (t.startsWith("proto ") && !t.startsWith(";") && !t.startsWith("#")) {
            proto = t.removePrefix("proto ").trim() + "-client"
        }
    }
    require(host != null) { "Config tidak punya baris 'remote'" }

    // STRIP all legacy cipher lines (case-insensitive) — OpenVPN3 rejects CBC.
    val cleanLines = config.lines().filter { line ->
        val t = line.trim().lowercase()
        !t.startsWith("cipher ") &&
            !t.startsWith("data-ciphers ") &&
            !t.startsWith("keysize ") &&
            !t.startsWith("connect-retry")
    }
    val finalConfig = cleanLines.joinToString("\n").trimEnd() +
        "\ndhcp-option DNS 1.1.1.1\ndhcp-option DNS 8.8.8.8\n" +
        "cipher CHACHA20-POLY1305\n" +
        "data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM\n" +
        "remote-cert-tls server\n" +
        "connect-retry 1 1\n" +
        "connect-retry-max 1\n" +
        "block-ipv6\n" +            // many gate servers mis-push v6 → hang
        "auth-user-pass\n"          // triggers provide_creds() → auto vpn/vpn

    return VpnProfile(
        name = serverName, config = finalConfig,
        host = host, port = port, proto = proto, country = country
    )
}

// Engine-side overrides that make it work:

// 1) Auto-creds for servers that demand auth:
// override fun provide_creds(creds: ClientAPI_ProvideCreds?): ClientAPI_Status {
//     creds?.setUsername("vpn"); creds?.setPassword("vpn"); return ClientAPI_Status()
// }

// 2) Always call super.event(e) in event() override (state mapping lives there).

// 3) In the VpnService Builder do NOT addAddress/addRoute yourself —
//    the engine's tun_builder callbacks set real values from the server push.
//    Conflicting fake address => connected-but-no-internet.
