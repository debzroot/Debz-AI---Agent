# FastSSH-style SSH tunnel apps — WebView account generation + JSch tunnel

Pattern used by HTTP Injector / KPN Tunnel class of apps: generate the account client-side in a WebView (human fills form + CAPTCHA → no Cloudflare blocks, no backend), auto-capture the result via JS injection, then tunnel with an embedded SSH client. DebSSH+ implemented this; verified August 2026.

## FastSSH site structure (deep-link on point)
- Server list pages: `https://www.fastssh.com/page/ssh-ssl-stunnel-servers/`, `.../ssh-udp-custom/`, `.../ssh-over-websocket-servers/`, `.../page/sggs-servers` etc.
- Account creator pages (the WebView target): links like
  `https://www.fastssh.com/page/ssh-account-creator-stunnel/server/1001027/ssh-stunnel-france/`
  Pattern: `/page/ssh-account-creator[-<type>]/server/<serverId>/ssh[-<type>]-<country>/`
  (type variants: plain ssh, `-udp`, `-stunnel`, `-websocket`).
- Form fields on creator pages (confirmed): hidden `serverid`, `ssid`; text `server` (readonly, id=`name`); `username` (id=`user`, maxlength 12); `password` (id=`pass`); submit button value `create ssh account`; a `#submit` button also exists.
- Success detection: page body contains `Created` / `Account` / `success` text after submit.

## WebView setup that works
- `javaScriptEnabled`, `domStorageEnabled`, `databaseEnabled`, `mixedContentMode = MIXED_CONTENT_ALWAYS_ALLOW`, realistic Android Chrome UA.
- Cookies on; `setAcceptThirdPartyCookies(webView, true)` on L+.
- JS bridge via `addJavascriptInterface(object { @JavascriptInterface fun onSuccess(user, pass) }, "Android")`.
- After `onPageFinished`, run a polling detector every ~1.5s:
  - regex body text for `/(created|success|account created|berhasil)/i`
  - read `document.getElementById('user'/'pass')` values; fallback regex `username[:\s]*(\S+)` / `password[:\s]*(\S+)` from body text
  - when both non-empty → `Android.onSuccess(user, pass)` once (guard with a `closed` flag)
- On success: close WebView, store account, enable Connect.

## Tunnel engine (JSch — MVP, pure Java)
```kotlin
implementation("com.github.mwiede:jsch:0.2.20")
```
- `jsch.getSession(user, host, port)`; `setPassword(pass)`; `StrictHostKeyChecking=no`; `PreferredAuthentications=password`; `connect(15000)`.
- Dynamic port forwarding → local SOCKS proxy: `session.setPortForwardingL("127.0.0.1", 1080, null, 0)`.
- Then `VpnService` establishes tun; traffic must be routed tun→SOCKS.

## Known gap (honest status)
JSch + SOCKS + VpnService alone does NOT give full internet routing — the tun→SOCKS hop needs a userspace TCP/UDP stack: `tun2socks` or `badvpn` (native libs per ABI, built via NDK in CI). Without it: SSH connects and SOCKS proxy listens, but apps don't get internet. This is the next work item; don't claim "internet works" until tun2socks is in.

## UI conventions for this user (Debz)
- Header = glitch banner (grid + scan lines + gradient title + pulsing subtitle), version NEVER in header — only inside the DEV layer.
- Theme from their `base.css` (hacker/terminal): `--green #39FF14`, `--red #FF5F56`, `--yellow #FFBD2E`, `--prompt #0D6EFD`, bg `#060B06` with 3px grid, glassmorphism cards with neon border, terminal window chrome (3 traffic-light dots + title bar), monospace logs.
- Always include a Share Logs button (DEV layer) for remote debugging.
