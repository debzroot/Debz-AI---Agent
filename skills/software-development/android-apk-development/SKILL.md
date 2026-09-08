---
name: android-apk-development
description: "Build Android APKs: Kotlin/Compose, Gradle, GitHub Actions."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, apk, kotlin, compose, gradle, github-actions, ci, vpn]
    category: software-development
---

# Android APK Development (Kotlin + Compose, CI-built)

## When to Use
User wants to build an Android APK from zero (personal or product app), scaffold a Kotlin/Compose project, wire GitHub Actions to build APKs automatically, integrate a third-party AAR (native engine/library) into an app, or debug Android build/connect failures — especially across a chat platform where the user tests on their phone and reports back.

## Core Architecture Pattern
- **Build on GitHub Actions, not the local box** (unless a full Android SDK is present). Runner has the Android SDK preinstalled; local arm64/Termux hosts don't. Workflow: checkout → actions/setup-java@v4 (temurin 17) → gradle/actions/setup-gradle@v4 → chmod +x gradlew → `./gradlew assembleDebug --no-daemon` → actions/upload-artifact@v4. Push to `main` = fresh APK artifact each time.
- **Scaffold files needed** (write each file separately — large multi-file writes hit stream timeouts; keep each write under ~8K tokens):
  - `settings.gradle.kts`, root `build.gradle.kts` (plugin versions, `apply false`), `gradle.properties`, `app/build.gradle.kts`
  - `AndroidManifest.xml`, `res/values/{themes.xml,colors.xml}`, adaptive icon (`res/mipmap-anydpi-v26/ic_launcher.xml` + `res/drawable/ic_launcher_foreground.xml`)
  - Gradle wrapper: download `gradle-wrapper.jar` + `gradlew` from the `gradle/gradle` GitHub repo at the matching tag (e.g. v8.7.0), write `gradle/wrapper/gradle-wrapper.properties`
  - Kotlin sources under `app/src/main/java/`
- **Known-good version matrix (AGP 8.5.2 era):** Gradle 8.7, AGP 8.5.2, Kotlin 1.9.24, **compileSdk/targetSdk 34** (AGP 8.5.2 is tested only up to 34 — 35 triggers AAPT errors on newer manifest flags), compose BOM 2024.09.03, `kotlinCompilerExtensionVersion` 1.5.14, JDK 17, minSdk 26, `android.useAndroidX=true`.
- Keystore signing for release builds: keystore + passwords via GitHub secrets; debug builds need no signing config.

## AAR Integration & Reverse-Engineering (when docs are missing)
Third-party Android libs on Maven Central are opaque `.aar` files. Pipeline that works:
1. `curl -sS https://repo1.maven.org/maven2/<group>/<artifact>/maven-metadata.xml` → versions.
2. Download `.aar` + `-sources.jar` (if present) + `.pom` — the POM lists **transitive deps** (often a second/third artifact you must know about) and the SCM URL → GitHub repo with more source.
3. `unzip -p lib.aar classes.jar > classes.jar`; `javap -classpath classes.jar com.x.Y` for public API, `javap -p -c` for internals/bytecode, `javap -s` for exact signatures.
4. `unzip -qo lib-sources.jar` → read the actual Kotlin source; it reveals bugs, intent constants, and internal-vs-public visibility.
5. **Maven AARs are RELEASE builds** → any `BuildConfig.DEBUG`-gated logging is compiled out; runtime errors are silently swallowed. If the library's logger is debug-gated, capture engine errors by forking/subclassing (see the OpenVPN reference for the full pattern).
6. Check the AAR's own `AndroidManifest.xml` (`unzip -p lib.aar AndroidManifest.xml`) — libraries often ship a complete service with the correct modern manifest pattern; prefer using it over writing your own.

## Pitfalls
- **`android:foregroundServiceType="vpn"` is NOT a valid value** — AAPT rejects it outright (valid values: camera, dataSync, mediaPlayback, location, specialUse, ...). VPN apps use `foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>` + `FOREGROUND_SERVICE_SPECIAL_USE` permission (this is exactly what ics-openvpn does).
- **compileSdk 35 with AGP 8.5.2** → "tested up to compileSdk 34" warning and AAPT errors for newer flags. Pin 34 instead of bumping AGP blindly.
- Android 13+ (API 33): request `POST_NOTIFICATIONS` at runtime or the foreground-service notification is invisible.
- API 26+: use `startForegroundService()` (must call `startForeground()` within ~5s); below 26 use `startService()`.
- **Kotlin interface properties vs methods:** an interface with `val x: T?` must be overridden as a property, not `getX()` — javap shows `getX()` which misleads. Kotlin nullable params (`String?`) must match exactly or you get `'overrides nothing'`.
- **Kotlin `internal` members are compile-invisible across modules** (objects, some constructors). Grep the sources jar before writing code that touches them.
- Compose: don't stack multiple `pointerInput` gesture detectors on one composable (conflicts); lift zoom/pan state to the parent; use `rememberUpdatedState` + a `resetKey` to avoid stale closures in gesture handlers.
- Discord/chat 2000-char message limit: deliver long files as `MEDIA:` attachments, not pasted code.

## Debug Loop (CI build + runtime)
- Build failed: `gh run watch <id> --repo owner/repo --exit-status`, then `gh run view <id> --log-failed | grep -E "e: |error:|What went wrong"`.
- Runtime bug reported via screen recording: `ffmpeg -i clip.mp4 -vf fps=4 frame_%03d.png`, then vision_analyze specific frames for on-screen error text.
- **Always surface raw error text in the UI** (overlay/log viewer) — silent failures are un-debuggable across a chat where you can't read logcat.

## Support files
- `references/openvpn-engine-integration.md` — full OpenVPN engine (tim06 AAR) integration deep-dive: the two library bugs and their workarounds, the correct VPN manifest pattern, engine-log capture by forking the service, and the VPN Gate free-config API format.
- `references/flutter-youtubedl-android-integration.md` — Flutter + youtubedl-android (native yt-dlp + ffmpeg) integration pattern: CI build.gradle patching, MethodChannel handler (init/update/download/share), Manifest/permissions, adaptive icons, signing workflow, common pitfalls.
- `references/kotlin-android-compilation-pitfalls.md` — Kotlin/Android compilation errors encountered and their fixes (Gson type inference, val/var confusion, missing AccessibilityService constants, Color.copy, duplicate classes, inner class ViewHolders, CoroutineScope.cancel, Material3 vs MaterialComponents parents, deprecated APIs, FAIL_ON_PROJECT_REPOS, ABI splits, XML escaping, missing resources, accessibility config).
