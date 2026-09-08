# GitHub Actions Android build — recipe + gotchas

Minimal working workflow for building a Kotlin/Compose APK on push (debug artifact, optional release on tag).

## Workflow skeleton

```yaml
name: Build APK
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - uses: gradle/actions/setup-gradle@v4
      - run: chmod +x gradlew
      - run: ./gradlew assembleDebug --no-daemon
      - uses: actions/upload-artifact@v4
        with:
          name: app-v0.1.${{ github.run_number }}
          path: app/build/outputs/apk/debug/*.apk
```

## Gradle wrapper without a local Android Studio

- `gradle/wrapper/gradle-wrapper.jar` can be fetched from the gradle GitHub repo tag: `https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar` (plus `gradlew` script from the same tag, chmod +x).
- `gradle/wrapper/gradle-wrapper.properties`: `distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-bin.zip`.

## Gotchas (each cost a failed run)

1. **AGP version ↔ compileSdk**: AGP 8.5.2 is tested only up to compileSdk 34. Setting 35 triggers `AAPT: error: 'vpn' is incompatible with attribute foregroundServiceType` — the attribute flags come from the compiled SDK, so an SDK the AGP doesn't know yields cryptic flag-list errors. Keep compileSdk/targetSdk at 34 with AGP 8.5.x, or bump AGP.
2. **`vpn` is not a valid `foregroundServiceType` value.** Valid types: camera, connectedDevice, dataSync, health, location, mediaPlayback, mediaProjection, microphone, phoneCall, remoteMessaging, shortService, specialUse, systemExempted. VPN apps use `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=vpn`.
3. **`BuildConfig` is off by default in AGP 8+** — enable `buildFeatures { buildConfig = true }` before referencing `BuildConfig.VERSION_NAME/CODE`, or you get `Unresolved reference: BuildConfig`.
4. **versionCode must strictly increase per build** or Android silently refuses/keeps the old APK. Derive in build.gradle.kts:
   ```kotlin
   val commitCount = try {
       ProcessBuilder("git", "rev-list", "--count", "HEAD")
           .start().inputStream.bufferedReader().readText().trim().toInt()
   } catch (_: Exception) { 1 }
   // versionCode = commitCount; versionName = "0.1.$commitCount"
   ```
   And name artifacts with the version so users download the right one (`name: app-v0.1.${{ github.run_number }}`). Stamp the version in the UI subtitle + log header so you can verify which build a user actually installed.
5. `Unable to strip the following libraries ... libovpn3.so` is a benign warning (JNI libs packaged as-is) — not a failure.
6. Node 20 deprecation annotations for checkout/setup-java v4 are warnings only.
7. Debug APK is unsigned-with-debug-key: users must **uninstall the old app first** when the applicationId stays the same but signature behavior confuses package managers — and versionCode monotonicity makes in-place upgrade work.
