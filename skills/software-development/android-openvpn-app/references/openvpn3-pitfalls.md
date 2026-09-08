# OpenVPN3 Pitfall Transcripts (from a real VPN Gate client build)

Each entry: the engine log/error signature → root cause → fix that actually worked.

## 1. "fromIndex = -1" crash on connect

```
e: ... OpenVPNConfigParser.kt: ... subList(-1, 0)
```
Library's `OpenVPNConfigParser.configFromLines` calls `linesByKey("<tls-crypt>")` unconditionally;
VPN Gate configs have no `<tls-crypt>` block, so `indexOfFirst` returns -1 → `slice(-1..0)` throws.
**Fix:** bypass the parser entirely. Build `OpenVPNConfig(host, port, type, configuration = rawConfigText)`
— `OpenVPNService.startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()`, so the raw text
goes straight to the engine.

## 2. Infinite reconnect loop: "crypto_alg: AES-128-CBC: bad cipher for data channel use"

```
Connected via tun
Client exception in transport_recv: crypto_alg: AES-128-CBC: bad cipher for data channel use
Client terminated, restarting in 2000 ms...
EVT RECONNECTING ... (forever) ... AUTH_FAILED ... EVT DISCONNECTED
```
VPN Gate configs ship `cipher AES-128-CBC`; the OpenVPN3 core (tim06) refuses CBC for the data
channel. Appending `data-ciphers` does NOT help — the server still pushes CBC and it's still in the
config. **Fix:** strip ALL `cipher` / `data-ciphers` / `keysize` / `connect-retry` lines
(case-insensitive, tolerate spaces) and append:
```
cipher CHACHA20-POLY1305
data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM
```
Log evidence of the fix working: `Tunnel Options: ... cipher CHACHA20-POLY1305, auth [null-digest]`.

## 3. "Session invalidated: DECRYPT_ERROR" right after EVT CONNECTED

```
EVT CONNECTED 219.100.37.205:443 ... (tun established, IP assigned)
Session invalidated: DECRYPT_ERROR
Client terminated, restarting in 2000 ms...
EVT RECONNECTING ... loop forever on the SAME server
```
SoftEther/VPN Gate servers with an AES-GCM data-channel bug. The OpenVPN core's internal
auto-reconnect retries the same broken server endlessly — `connect-retry-max 1` does NOT stop this.
**Fix:** in the `log()` override, on `DECRYPT_ERROR` or `Session invalidated`, call `stopEngine()`
(the engine-level stop, capped at 2 hits) so state → IDLE and your app-level auto-failover moves to
the next server. ChaCha20-POLY1305-first ordering also reduces how often this triggers.

## 4. UI stuck on "Connecting…" forever while engine is actually connected

```
EVT CONNECTED ... (in log)
STATE: CONNECTING (UI never left Connecting)
```
Overriding `event()` without calling `super.event(e)` breaks the base-class mapping of engine
events → `updateStateThread` → UI state. **Fix:** always end `event()` overrides with `super.event(e)`.
This one bug also made Cancel dead and auto-failover never fire.

## 5. Timeout killed a healthy connection

```
EVT CONNECTED ... STATE: CONNECTED
TIMEOUT 20s — cancelling engine
STATE: IDLE
```
Timeout coroutine looped on `thread.isAlive` — but the engine thread stays alive for the whole VPN
session (it polls status). **Fix:** loop condition `thread.isAlive && state != CONNECTED`, and in the
catch block only stop if `state != CONNECTED`.

## 6. Cancel button did nothing

Two root causes:
- `interrupt()` alone cannot stop native `connect()`. **Fix:** `(management as? OpenVPNThreadv3)?.stopVPN()` before interrupt.
- Race: `management` was assigned INSIDE the spawned thread, so `stopEngine()` from the main thread
  saw null. **Fix:** construct the `OpenVPNThreadv3` object and assign `management` BEFORE starting the thread.

## 7. Connected but zero internet (bengong)

```
EVT CONNECTED ... Connected via tun ... STATE: CONNECTED  (but no traffic)
```
`VpnService.Builder` had hardcoded `addAddress("10.111.0.2", 24)` + `addRoute("0.0.0.0", 0)` +
DNS — these CONFLICT with the real IP the engine pushes via `tun_builder_add_address` →
broken routing table. **Fix:** leave the Builder nearly empty (`setSession`, `setMtu`,
`setBlocking` only); the engine adds address/routes/DNS from the server push.
Also add `block-ipv6` to the config: VPN Gate servers rarely push working IPv6 and Android hangs
on IPv6-first lookups, which also looks like "connected but no internet".

## 8. MissingForegroundServiceTypeException crash on connect (Android 14+)

```
android.app.MissingForegroundServiceTypeException: Starting FGS without a type ... targetSDK=34
```
Manifest service needs:
```xml
<service ... android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn" />
</service>
```
plus `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />`.
`foregroundServiceType="vpn"` is NOT a valid AAPT value (AAPT rejects it) — always specialUse + subtype property.

## 9. "Always installs the old version" — versionCode never bumped

`versionCode = 1` on every build → Android treats every APK as the same version and keeps the old
one (or fails the install silently). **Fix:** `versionCode = git rev-list --count HEAD` in
`build.gradle.kts` and name artifacts `app-v0.1.<run_number>` so the newest is obvious.
Related: AGP 8+ requires `buildFeatures { buildConfig = true }` before `BuildConfig.VERSION_NAME` resolves.

## 10. AUTH_FAILED = server full, not an app bug

```
Sending PUSH_REQUEST to server...
AUTH_FAILED
EVT AUTH_FAILED
```
Free VPN Gate servers hit their user cap constantly. Treat as fail-fast (report error, let
auto-failover pick the next server), and expect most servers in a fresh list to fail. Server list
must auto-refresh every ~5 min because the pool churns.
