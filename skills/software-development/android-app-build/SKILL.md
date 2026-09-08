---
name: android-app-build
description: "Build Android APKs: Kotlin/Compose, Gradle, GitHub CI."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, apk, gradle, kotlin, compose, github-actions, ci, openvpn, vpn]
    category: software-development
---

# Building Android APKs

## When to Use
User wants to build an Android APK — new app from zero, CI build via GitHub Actions, fix Gradle/AGP build errors, embed a library with native code (VPN engines, etc.), or set up an Android project WITHOUT Android Studio on the local machine (Termux chroot, headless server, etc.).

## Key decision: build where?
- **Local arm64/Termux chroot**: don't install the full Android SDK + Gradle for a one-off. Push source to GitHub and let Actions build (x86_64 runner, SDK preinstalled, ~4 min first build).
- Local JDK 17 is still useful for AAR inspection: `apt-get install -y default-jdk-headless`.

## Project skeleton (minimal, proven)
- `settings.gradle.kts` — pluginManagement repos (google, mavenCentral, gradlePluginPortal); dependencyResolutionManagement with `FAIL_ON_PROJECT_REPOS`; `include(":app")`
- `build.gradle.kts` (root) — plugins with versions + `apply false`
- `gradle.properties` — `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8`, `android.useAndroidX=true`, `android.nonTransitiveRClass=true`
- `app/build.gradle.kts` — namespace, compileSdk/minSdk/targetSdk, Compose BOM, `buildFeatures.compose`
- `app/src/main/AndroidManifest.xml` + `res/values/themes.xml`, `colors.xml`, adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml` + drawable foreground vector)
- `.github/workflows/build.yml`

## Bootstrap Gradle wrapper without Android Studio
```bash
mkdir -p gradle/wrapper
curl -sSL -o gradle/wrapper/gradle-wrapper.jar "https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar"
curl -sSL -o gradlew "https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradlew"
chmod +x gradlew
```
Plus `gradle/wrapper/gradle-wrapper.properties` with `distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-bin.zip`. Matches: Gradle 8.7 + AGP 8.5.2 + Kotlin 1.9.24 + Compose compiler 1.5.14 + JDK 17.

## CI workflow (GitHub Actions)
```yaml
- uses: actions/checkout@v4
- uses: actions/setup-java@v4           # temurin, java-version: "17"
- uses: gradle/actions/setup-gradle@v4
- run: chmod +x gradlew && ./gradlew assembleDebug --no-daemon
- uses: actions/upload-artifact@v4     # path: app/build/outputs/apk/debug/*.apk
# optional: softprops/action-gh-release@v2 (if: startsWith(github.ref,'refs/tags/'))
```
- Monitor: `gh run watch <id> --exit-status --interval 15`; failed logs: `gh run view <id> --log-failed | grep -E "e: |error:"`
- Download artifact: `gh run download <id> -D dir` — APKs are large, give a generous timeout (300s+).

## Pitfalls (learned the hard way)
1. **AGP ↔ compileSdk coupling**: AGP 8.5.2 is only tested up to compileSdk 34. compileSdk 35 → AAPT errors (e.g. any API-34+ attribute). Keep compileSdk/targetSdk ≤ the AGP's tested max, or bump AGP deliberately.
2. **`foregroundServiceType="vpn"` is NOT a valid value** — AAPT rejects it outright. Real VPN apps (ics-openvpn) use `foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission.
3. **Kotlin interface overrides**: `overrides nothing` usually = nullability mismatch (`String?` vs `String`, `CIDRIP?` vs `CIDRIP`) or the member is a Kotlin `val` (javap shows `getCtResolver()`; override as `override val ctResolver: ...`, NOT `override fun getCtResolver()`).
4. **javap the real artifact, don't guess** — `unzip -p lib.aar classes.jar > c.jar && javap -s -classpath c.jar com.pkg.Interface` gives exact signatures incl. Kotlin nullability. Sources jars are often incomplete (only BuildConfig).
5. **Pin the exact library version you inspected** — transitive deps drift (`io.github.tim06:openvpn:1.1.3` → pin `basevpnprotocols:1.1.1` too).
6. **Write one file per tool call, keep each under ~8K tokens** — a giant multi-file `write_file` in one call times out the delivery stream.
7. **APK structure changes → user must uninstall the old APK first** (signature/service-process mismatch causes install failure on upgrade).

## Verification
- `unzip -l app-debug.apk | grep -E "lib/|classes"` — confirm native libs (e.g. `lib/arm64-v8a/libovpn3.so`) + classes are packaged.
- Fetch limit: large (1MB+) responses may need `curl` with generous `-m`; partial body is still parseable.

## Support files
- `references/openvpn-vpn-gate.md` — embedding OpenVPN3 (tim06 Maven lib, full service-integration recipe), VPN Gate free-server API, canonical ics-openvpn FGS pattern.
