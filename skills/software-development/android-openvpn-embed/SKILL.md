---
name: android-openvpn-embed
description: "Android OpenVPN embed: library, pitfalls, CI APK build."
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, openvpn, vpn, apk, gradle, github-actions, vpngate, kotlin, compose]
    category: software-development
---

# Android OpenVPN Embed (VPN client app)

## When to Use
Building or modifying an Android VPN client app that embeds an OpenVPN engine and connects to free public servers (VPN Gate, etc.), or building Android APKs via GitHub Actions. All facts below verified in practice (2026-08, DebNet+ project).

## Library choice (verified)
- **Working**: `io.github.tim06:openvpn:1.1.3` + `io.github.tim06:basevpnprotocols:1.1.1` from Maven Central (Apache-2.0). Engine = OpenVPN 3 C++ (SWIG bindings `net.openvpn.ovpn3.ClientAPI_*`), AAR ships `libovpn3.so` for arm64-v8a/armeabi-v7a/x86/x86_64 + `assets/pie_openvpn.*`.
- **NOT available**: `de.blinkt:openvpn` (404 on Maven Central). JitPack `com.github.schwabe:ics-openvpn` builds **Error for every 0.7.x tag** (0.6.x ok but ancient).
- Original ics-openvpn is GPL; the tim06 fork is Apache-2.0 and carries a complete, ready-made VPN service.

## Integration — the RIGHT way (don't write your own VpnService)
The AAR declares its own `com.tim.openvpn.service.OpenVPNService` in its manifest: `android:process=":openvpn"`, `foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>`, `android:permission="android.permission.BIND_VPN_SERVICE"`. Use it:

```kotlin
// VpnServiceConnection is ABSTRACT -> anonymous subclass
connection = object : VpnServiceConnection(
    context.applicationContext,
    OpenVPNService::class.java,
    { st -> _state.value = st },   // (ConnectionState) -> Unit
    scope
) {}
connection?.start(cfg, emptySet(), serverName)
connection?.stop(); connection?.stopServiceIfNeed(true)
```
Alternative: `OpenVPNService.Companion.startService(context, config, notificationClass, allowedApps)` / `stopService(context)`.

## PITFALL: `foregroundServiceType="vpn"` is INVALID
AAPT rejects it ("'vpn' is incompatible with attribute foregroundServiceType"). The real flag set has no `vpn`. Correct Android 14+ pattern (used by ics-openvpn and the tim06 AAR): `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn` + permission `FOREGROUND_SERVICE_SPECIAL_USE`. `FOREGROUND_SERVICE_VPN` is a permission, not a type.

## PITFALL: OpenVPNConfigParser crashes `fromIndex = -1` on VPN Gate configs
`OpenVPNConfigParser.parse()` unconditionally calls `linesByKey("<tls-crypt>")`; if the config lacks that block, `indexOfFirst` returns -1 → `slice(-1..0)` → "SubList fromIndex = -1" crash (shown as red error text in the app). **Fix: bypass the parser** — construct `OpenVPNConfig(host=…, port=…, type="tcp-client"/"udp-client", configuration=<raw config text>)`. `OpenVPNService.startOpenVPN()` uses `conf.configuration ?: conf.buildConfig()`, so the raw config goes to the engine untouched. Extract host/port/proto from the config's `remote`/`proto` lines yourself (skip `;`/`#` comments).

## PITFALL: VpnServiceConnection never delivers the config (silent connect-dead)
`VpnServiceConnection.start(config: IVpnConfiguration, allowedApps, notificationClassName)`
only does `bindService(...)` + `getService()?.startVPN()`. It NEVER puts the config into the
Intent. But `OpenVPNService.startOpenVPN()` runs `val conf = requireNotNull(config)` where
`config` is only ever set in `prepare(intent)` — i.e. from the Intent extra `CONFIGURATION_KEY`.
So binding alone → config stays null → requireNotNull throws → connect dies silently while the
key icon still appears (because `showNotification()` runs first).

**Fix:** start the service yourself with the config as an intent extra, THEN bind separately
for the state listener:
```kotlin
val intent = Intent(ctx, DebOpenVpnService::class.java).apply {
    setPackage(pkg)
    putExtra(ProtocolsVpnService.ACTION_KEY, ProtocolsVpnService.ACTION_START_KEY)
    putExtra(DebOpenVpnService.CONFIGURATION_KEY, cfg)      // THE FIX
    putExtra(ProtocolsVpnService.NOTIFICATION_CLASS_KEY, null as String?)
    putExtra(ProtocolsVpnService.ALLOWED_APPS_KEY, emptyArray<String>())
}
ctx.startForegroundService(intent)                          // delivers config + starts engine
ctx.bindService(Intent(ctx, DebOpenVpnService::class.java), conn, Context.BIND_AUTO_CREATE) // states only
```
See `references/tim06-openvpn-api.md` for the full service lifecycle + fork recipe.

## PITFALL: engine logs are ship-shaped invisible (release AAR)
`OpenVPNLogger` only logs when `BuildConfig.DEBUG=true`; the Maven release AAR has DEBUG=false,
so every engine error (auth-fail, TLS cert, bad-cipher, server-unreachable) is swallowed silently.
To surface errors to the user: subclass `OpenVPNThreadv3` and override `log()`, `event()`,
`connect()`, forwarding to a shared StateFlow/`VpnController`. `OpenVPNService` is FINAL in the
AAR, so you must fork it (full source is in `OpenVPNService.kt`; copy `startOpenVPN`,
`startTun`, route installers, `openvpnStopped` — ~270 lines — into your own service).
See `references/tim06-openvpn-api.md` "Engine log capture".

## Kotlin override gotchas (IOpenVPNService)
- Interface is Kotlin with **nullable** params: `addDNS(dns: String?)`, `setLocalIP(ip: CIDRIP?)`, `addRoute(a: String?, …)`, `trigger_sso(url: String?)`. Non-null overrides → "overrides nothing".
- `ctResolver` and `connectivityManager` are **properties**: `override val ctResolver: ContentResolver?` — NOT `getX()` methods.
- Full contract: `references/tim06-openvpn-api.md`.

## PITFALL: AGP vs compileSdk
AGP 8.5.2 is tested up to compileSdk **34**. compileSdk/targetSdk 35 with AGP 8.5.2 → AAPT failures. Use 34 (apps still run on Android 15/16/17). Bump AGP only if you need 35.

## VPN Gate API (free server list + configs)
- Endpoint: `https://www.vpngate.net/api/iphone/` — plain CSV, no key, ~1.3 MB, slow (~30s+). Set generous read timeouts.
- 15 columns; OpenVPN config = **base64 in last column**; Message field may contain commas → `split(",", limit=15)`.
- First line `*vpn_servers`, header `#HostName,…` — skip both.
- **Stream**: parse line-by-line and push chunks to the UI (server-by-server appearance) instead of waiting for the full body; cache raw text to `context.filesDir` so next launch shows the list instantly, then refresh in background.
- Format + sample: `references/vpngate-api.md`.

## Build APK via GitHub Actions (debug, no keystore needed)
Workflow: checkout → setup-java 17 (temurin) → gradle/actions/setup-gradle → `chmod +x gradlew` → `./gradlew assembleDebug --no-daemon` → upload-artifact `app/build/outputs/apk/debug/*.apk`. Template: `templates/github-actions-build.yml`. Release builds need keystore via secrets + signingConfig.

Dev loop: `git push` → `gh run watch <runId> --repo <repo> --exit-status --interval 15` → on failure `gh run view <runId> --repo <repo> --log-failed | grep -E "e: |error:|What went wrong"` → fix → push again. Kotlin errors print as `e: file://…:line:col …`.

## PITFALL: free VPN Gate servers are flaky — make connect resilient
Public VPN Gate/SoftEther relays are often full or throttled, so a single TCP:443 attempt
usually stalls at ASSIGN_IP/RECONNECTING (key icon appears, no internet, overlay stuck on
"Connecting…"). Robust UX pattern (verified):

1. **Explicit timeout** — fail fast instead of hanging: start a coroutine timer (≈20s); if state
   isn't `CONNECTED`, force-stop + report a clear message ("Server penuh/lambat"). The user must
   never have to force-stop the app from Settings.
2. **Always-on Cancel button** — visible in BOTH the status card and the connecting overlay;
   cancels the in-flight connection immediately.
3. **Protocol retry fallback** — VPN Gate servers always answer UDP:1194, which rarely stalls the
   way TCP:443 does. Track attempt count; on retry (and randomly for "Random Country"), rewrite
   `proto` → udp / `remote … <port>` → 1194 and add `dhcp-option DNS 1.1.1.1 / 8.8.8.8`.
4. **Pick healthy servers, not random ones** — filter `score > 0 && ping > 0`, sort by descending
   score, pick from the top ~60% (the rest are often offline).
5. **Surface the protocol in the UI** — show `server · UDP` / `server · TCP` in the overlay so
   the user can see which path is being tried.
6. **DNS fallback** is essential — a server that doesn't push DNS leaves you with a TUN that has
   no resolver → Android immediately flags "Wi-Fi not connected to internet". Inject DNS into the
   config before handing to the engine.

## Build error patterns & fixes
Common Kotlin compile errors encountered during this work and their fixes: `references/build-error-patterns.md`.

## Pitfalls (general)
- User downloads APKs from the Actions UI (Artifacts); `gh run download` can time out on multi-MB APKs. **Always tell the user to uninstall the previous build first** when the app structure changed (new service/process) or install fails.
- VPN UX: expose `ConnectionState` as StateFlow; overlay = slide-down + spinner "Connecting…" → green "Connected" (auto-hide ~1.6s) → red "Gagal" + error text + Retry. Server list: cache-first, background refresh, scale-in per item, country filter from the full list (not the filtered one).
- Compose zoomable image: lift scale/offset state to the parent; reset via a `resetKey` passed to `pointerInput` (else the gesture closure captures stale values). Tap-outside-to-close: full-size background Box with clickable, close button optional — user preference in DebNet+ was NO X button, tap outside resets zoom first, closes when already at 1x.

## Support files
- `references/tim06-openvpn-api.md` — full tim06 library API + fork recipe
- `references/vpngate-api.md` — VPN Gate CSV format + sample config
- `references/build-error-patterns.md` — common Kotlin compile errors + fixes
- `templates/github-actions-build.yml` — GitHub Actions workflow template
