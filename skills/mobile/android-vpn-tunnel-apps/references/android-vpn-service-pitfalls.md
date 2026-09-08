# Android VPN Service Pitfalls (FGS, Notif, Build)

## Foreground service (Android 14+/targetSdk 34)

- `MissingForegroundServiceTypeException` = service lacks a type. VPN is NOT a valid FGS type — declare:
  ```xml
  <service android:name=".vpn.SshVpnService"
      android:foregroundServiceType="specialUse"
      android:permission="android.permission.BIND_VPN_SERVICE">
      <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>
  </service>
  ```
  Plus `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` permissions.
- `startForegroundService()` (O+) → MUST call `startForeground()` quickly or the system throws.

## Notification sync (app Connected vs notif "Connecting")

- Update FGS notifications via `startForeground(SAME_ID, newNotif)` on the **main thread** (`Handler(Looper.getMainLooper()).post`). `NotificationManager.notify()` from the engine thread is unreliable for FGS.
- Add a `Disconnect` action via `PendingIntent.getService(..., FLAG_IMMUTABLE)` + handle in `onStartCommand(intent.action == ACTION_STOP)`.
- If you run a 1s timer to show elapsed time, keep the `Runnable` reference and `removeCallbacks` on every state change — otherwise a stale "Connected" ticker flips the notif back to Connected while the app is Connecting.

## Disconnect cleanup order

`stopVpn()`: stop engine → release wakelock → update notif to "Disconnected" → `handler.postDelayed({ stopForeground(STOP_FOREGROUND_REMOVE) }, 800)` → null builder. Immediate `stopForeground` on some devices leaves the notif visible with stale text.

## Compose stale-closure (health-check self-DC bug)

```kotlin
// WRONG — vpnState captured from composition stays IDLE forever
if (vpnState == IDLE) { healthCheck() }

// RIGHT — read the flow fresh at execution time
val now = VpnController.state.value
if (now == IDLE || now == DISCONNECTED) { healthCheck() }
```
A 5-min auto-refresh that doesn't check fresh state will clear/fetch/health-check the server list **through the live tunnel**, hammering keepalive → KEEPALIVE_TIMEOUT → self-disconnect after ~20 min. Skip ALL refresh work while CONNECTING/CONNECTED.

## GitHub Actions APK pipeline

- `versionCode` from `System.getenv("GITHUB_RUN_NUMBER")` (shallow checkout makes `git rev-list --count HEAD` return 1 forever → every build "v0.1.1 build 1" → Android refuses to update).
- Artifact name includes the version so users stop grabbing stale APKs.
- `buildFeatures { buildConfig = true }` required for `BuildConfig.VERSION_NAME` on AGP 8+.
- Composite builds: `settings.gradle.kts` (pluginManagement google/mavenCentral), root `build.gradle.kts` with `apply false`, `gradle.properties` (`android.useAndroidX=true`), wrapper jar fetched from `raw.githubusercontent.com/gradle/gradle/v8.7.0/...`.

## Logging to file (root-cause loop)

`LogSaver`: append every engine/state/error line to `filesDir/logs/debssh_<ts>.log`; stamp version header `=== v6.6.6 (build N) log started ... ===`; share via FileProvider button. User sends the .log → grep `STATE:` lines to distinguish "UI mapping broken" vs "engine genuinely failing".
