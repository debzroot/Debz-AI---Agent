# Embedding OpenVPN in an Android App (verified 2026-08)

## Choosing the dependency
- `de.blinkt:openvpn` (ics-openvpn) is NOT on Maven Central (404) — cannot `implementation()` it.
- JitPack `com.github.schwabe:ics-openvpn` — all 0.7.x builds returned "Error" at time of writing. Don't rely on it.
- Working: **`io.github.tim06:openvpn:1.1.3`** on Maven Central (Apache-2.0). Its POM depends on `io.github.tim06:basevpnprotocols` (1.1.0; 1.1.1 latest). The AAR ships `jni/{arm64-v8a,armeabi-v7a,x86,x86_64}/libovpn3.so` + `assets/pie_openvpn.*` — an OpenVPN3 (ovpn3) engine, not old ics-openvpn 2.x.

## Engine API contract
- Engine classes live under `net.openvpn.ovpn3.ClientAPI_*` (OpenVPN3). `com.tim.openvpn.OpenVPNThreadv3` extends `ClientAPI_OpenVPNClient`; constructor `(IOpenVPNService, configString)`; run on its own thread; `stopVPN()` disconnects; `static { System.loadLibrary("ovpn3"); }` inside the thread class.
- Host app MUST implement `com.tim.openvpn.service.IOpenVPNService` (Kotlin interface — 16 methods):
  `setMtu(int)`, `addDNS(String)`, `addRoute(CIDRIP, Boolean)`, `addRoute(String,String,String,String)`, `addRoutev6(String,String)`, `setDomain(String)`, `addHttpProxy(String,int):Boolean`, `openTun():ParcelFileDescriptor`, `setLocalIP(CIDRIP)`, `setLocalIPv6(String)`, `protectFd(int):Boolean`, `trigger_sso(String)`, `getCtResolver():ContentResolver`, `getConnectivityManager()`, `openvpnStopped()`, `updateStateThread(ConnectionState)`.
- Callback flow: engine calls `openTun()` → return `vpnBuilder.establish().detachFd()`; `setLocalIP(new CIDRIP(ip, prefix))`; reroute-gw → `addRoute("0.0.0.0","0.0.0.0","127.0.0.1","vpnservice-tun")`; DNS via `addDNS`.
- State enum: `com.tim.basevpn.state.ConnectionState` = IDLE, READYFORCONNECT, CONNECTING, CONNECTED, DISCONNECTING, DISCONNECTED, PERMISSION_NOT_GRANTED (Parcelable).
- The AAR's sources jar is incomplete for some classes → extract bytecode contracts:
  `unzip -p openvpn-1.1.3.aar classes.jar > c.jar && javap -classpath c.jar com.tim.openvpn.service.IOpenVPNService`
  (Debian: `apt-get install -y default-jdk-headless`; javap 21 reads these fine.)

## Host VpnService pattern
- Manifest: `<service android:name=".vpn.XxxVpnService" android:permission="android.permission.BIND_VPN_SERVICE" android:exported="false"><intent-filter><action android:name="android.net.VpnService"/></intent-filter></service>`
- Permissions: INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, FOREGROUND_SERVICE, FOREGROUND_SERVICE_VPN (Android 14+).
- Pre-flight: `VpnService.prepare(context)` returns null (granted) or an Intent → launch via registerForActivityResult; on RESULT_OK connect with the pending server/config (stash it in a field first).
- Start: `startForegroundService` (O+); service builds `VpnService.Builder().setSession(name).setMtu(1500).setBlocking(true).addDisallowedApplication(packageName)`; notification channel IMPORTANCE_LOW; `startForeground` BEFORE establish.
- OpenVPN3 config string = the whole .ovpn file text (CA/certs inline) — pass straight to OpenVPNThreadv3.

## VPN Gate free server source (configs for "random country" apps)
- Endpoint: `https://www.vpngate.net/api/iphone/` — plain CSV text, no API key. Header line starts `#`, footer starts `*`. Payload up to ~1.3MB — use a read timeout ≥ 30s.
- 15 comma-separated columns; **OpenVPN config is base64 in the LAST column (index 14)**. The Message column can contain commas → `split(",", limit=15)`.
- Columns: HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,ConfigBase64.
- Send a browser-like User-Agent header or requests can stall. Decode base64 → connectable .ovpn (CA embedded).
- Free public gate, no account; filter by score/ping in-app and offer a refresh button — heavy traffic endpoints can drop.
