# SSH Tunnel Stack (HTTP Injector / KPN Tunnel style)

## Components

1. **SSH client**: JSch (`com.github.mwiede:jsch`) for MVP; Dropbear native (.so per ABI, NDK build) for production speed/battery.
2. **SOCKS proxy**: JSch `session.setPortForwardingL("127.0.0.1", 1080, null, 0)` → dynamic port forwarding = SOCKS5 server locally.
3. **TUN + forwarder**: `VpnService.Builder` creates tun; a forwarder thread reads IP packets off the tun fd and relays TCP through the SOCKS proxy (tun2socks pattern).

## SSH session hardening (connection longevity)

```kotlin
val s = jsch.getSession(username, host, port)
s.setPassword(password)
s.setConfig("StrictHostKeyChecking", "no")
s.setConfig("PreferredAuthentications", "password")
s.setServerAliveInterval(30_000)   // keepalive ping — server won't kill idle session
s.setServerAliveCountMax(5)
s.connect(20_000)
s.setPortForwardingL("127.0.0.1", 1080, null, 0)
```

- Auto-retry connect 3x with 3s delay before declaring ERROR — transient network blips shouldn't end the session.
- Read connection state (connected vs error) with `session.isConnected` when reacting to network change.

## Wakelock discipline (THE anti-DC factor)

- Acquire `PowerManager.PARTIAL_WAKE_LOCK` **at service `onStartCommand`** (before connecting), release only on real disconnect — NOT gated on CONNECTED state.
- Request `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (manifest `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) on first connect — standard VPN-app UX, user taps Allow once.
- Without both: Android Doze throttles the process when screen is off → keepalive pings stop → server drops session minutes later (the "DC sendiri setelah beberapa menit" symptom).

## Pure-Java tun2socks forwarder (MVP)

Reads IPv4 packets from `ParcelFileDescriptor.AutoCloseInputStream(tunFd)`:

```kotlin
val version = (packet[0].toInt() shr 4) and 0xF   // must be 4
val ihl = (packet[0].toInt() and 0xF) * 4
val protocol = packet[9].toInt() and 0xFF          // 6 = TCP
val srcIp = ipToString(packet, 12); val dstIp = ipToString(packet, 16)
val srcPort = ((packet[ihl].toInt() and 0xFF) shl 8) or (packet[ihl+1].toInt() and 0xFF)
val dstPort = ((packet[ihl+2].toInt() and 0xFF) shl 8) or (packet[ihl+3].toInt() and 0xFF)
val flags = packet[ihl+13].toInt() and 0x3F        // SYN=0x02, FIN=0x01, RST=0x04
```

- On SYN → open a SOCKS5 connection to `dstIp:dstPort` via the local proxy:
  - Greeting: `[0x05, 0x01, 0x00]` → expect `[0x05, 0x00]`
  - Connect: `[0x05, 0x01, 0x00, 0x01, ip4×4, portHi, portLo]` → expect reply[1]==0
- On FIN/RST → close the mapped socket.
- **Limitation (be honest with user)**: pure-Java forwarder handles TCP only. UDP (games, video calls) needs native badvpn/tun2socks. Response direction (server→app) must write back into `AutoCloseOutputStream(tunFd)` — implement a reverse reader loop per socket.

## Account source via WebView (FastSSH)

See `references/webview-account-automation.md`. Key: the SSH **host/port come from the generated-account result page**, NOT from static server data — placeholder hostnames (`ssh-sg.fastssh.com`) are fake and cause `UnknownHostException`. Parse `Host:` / `Port:` out of the "Account Created" block.
