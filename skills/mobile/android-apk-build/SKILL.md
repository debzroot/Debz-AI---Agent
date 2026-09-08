---
name: android-apk-build
description: "Build Android APKs via Gradle + GitHub Actions CI."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, apk, gradle, kotlin, compose, github-actions, ci, vpnservice, openvpn]
    category: mobile
---

# Android APK Build (Gradle + GitHub Actions)

## When to Use
- User wants an Android APK for their own app, built via GitHub Actions instead of a local Android SDK.
- Scaffolding a Kotlin/Jetpack Compose project from zero on a headless server.
- Embedding native engines (OpenVPN3, etc.) or hitting AAPT/AGP version errors.

## Core Workflow
1. **Scaffold on the server** (no SDK needed): `settings.gradle.kts`, root `build.gradle.kts` (plugin versions with `apply false`), `gradle.properties`, `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `res/values/*`, Kotlin sources under `app/src/main/java/<pkg>/`.
2. **Gradle wrapper**: commit `gradlew`, `gradlew.bat`, and `gradle/wrapper/gradle-wrapper.jar` + `.properties`. Grab the jar from the gradle repo raw (`https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar`) or generate locally if gradle exists.
3. **GitHub Actions workflow** (`.github/workflows/build.yml`):
   - checkout → setup-java (temurin 17) → gradle/actions/setup-gradle → `chmod +x gradlew` → `./gradlew assembleDebug --no-daemon` → upload-artifact@v4 with `app/build/outputs/apk/debug/*.apk`.
   - Release on tags: softprops/action-gh-release@v2 with the same files.
4. **Iterate**: push → `gh run list --repo <owner>/<repo> --limit 1` → `gh run watch <id> --repo ... --exit-status` → on failure `gh run view <id> --repo ... --log-failed | grep -E "e: |error:|What went wrong"`.
5. **Verify artifact**: `gh run download <id> --repo ... -D dir` (APKs are big — allow a long timeout) then `unzip -l app-debug.apk | grep -E "lib/|classes"` to confirm native ABIs and dex are present.

### Kotlin/Compose CI debugging loop (this session)
When a GitHub Actions Kotlin/Compose build fails with `e: ...` errors:
1. `gh run watch <id> --repo <owner>/<repo> --exit-status --interval 12` to track progress; on failure:
   `. gh run view <id> --repo ... --log-failed 2>&1 | grep -E "e: |error:|FAILURE" | head -15` surfaces the real errors (CI output is verbose).
2. Fix locally, commit, push — a new run auto-triggers; do **not** re-trigger manually.
3. Common Compose-specific errors from this session (full detail in `references/compose-ci-debugging.md`):
   - **Trailing-lambda binding**: `Field("Host", host) { host = it }` — Kotlin binds the trailing lambda to the **last parameter whose type is a function type**. If `onChange` isn't last (e.g. `isPassword`, `height` follow), the lambda goes to the wrong slot → "No value passed for parameter 'onChange'" + "Unresolved reference: it". Fix: **named arguments**: `onChange = { host = it }`.
   - **Internal `Modifier.weight`**: `androidx.compose.foundation.layout.weight` is internal in recent Compose — `import ...weight` → "it is internal". Use `weight()` only within `RowScope`/`ColumnScope`, or replace with `fillMaxWidth()` / fixed arrangement.
   - **Regex-rename double-hit**: bulk sed/Python replacement over `Field(...) { }` patterns can **double-replace substrings** (e.g. `NeoField` → `NeoNeoField`) or corrupt the function definition (`label = label: String`). Verify the signature line survives a rename; prefer context-anchored replacements.
- **AGP version ↔ compileSdk**: AGP 8.5.2 is only tested up to compileSdk 34. compileSdk 35 warns AND can break AAPT on flags added in API 35. Pin compileSdk/targetSdk to the AGP's tested max rather than bumping AGP (each AGP bump risks a new round of errors).
- **`foregroundServiceType="vpn"` is NOT a valid AAPT value** — valid types are specialUse, dataSync, mediaPlayback, etc. BUT the classic "no type at all" pattern crashes at RUNTIME on Android 14+ (targetSdk 34): `MissingForegroundServiceTypeException: Starting FGS without a type`. Correct manifest (this is exactly what ics-openvpn ships):
  ```xml
  <service android:name=".vpn.XxxVpnService"
      android:permission="android.permission.BIND_VPN_SERVICE"
      android:exported="false"
      android:foregroundServiceType="specialUse">
      <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="vpn"/>
  </service>
  ```
  plus `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />`. Also request POST_NOTIFICATIONS on Android 13+.
- **tim06 library bugs (debugging session v20-v32)** — see `references/openvpn-embedding.md`:
  - `VpnServiceConnection.start(config, …)` DISCARDS the config — deliver config only via intent extra `CONFIGURATION_KEY` through `OpenVPNService.Companion.startService()`; bind only for state.
  - `OpenVPNConfigParser` crashes "fromIndex = -1" on configs without `<tls-crypt>` (all VPN Gate configs) — build `OpenVPNConfig` manually, set `configuration` = raw config text (engine uses `conf.configuration ?: conf.buildConfig()`).
  - Release AAR silences `OpenVPNLogger` (`BuildConfig.DEBUG=false`) — subclass `OpenVPNThreadv3` and override `log()`/`event()`/`connect()` to surface engine errors in the UI.
  - Native engine can't be stopped with `Thread.interrupt()` — call `stopVPN()` on the management object; pair with a coroutine `withTimeout` for a connect timeout. This is why "Cancel" appears dead.
  - `CIDRIP(String,String)` ctor is `internal` — use `CIDRIP(ip, prefixInt)`.
- **Interactive CLIs in background sessions**: `gh auth login --web` hangs (prompts never accept PTY input). Use the manual device flow — see the `github-auth` skill.
- **Stream limits**: write project files one tool call each; batched multi-file writes time out on large payloads. Keep each file under ~8K tokens.
- **Implementing a Kotlin interface from an AAR**: inspect real bytecode with `javap` first — Kotlin interfaces may declare nullable params and `val` properties rather than getter methods; a signature mismatch surfaces as "overrides nothing" on every method.

### Flutter APK via GitHub Actions CI (this session: "DebDown+" downloader app)
Same "no local SDK → build in CI" pattern, but the app is **Flutter**, not Kotlin/Compose:
- Workflow steps: checkout → setup-java (zulu 17) → `subosito/flutter-action@v2` (`flutter-version: 3.19.x`, `channel: stable`, `cache: true`) → **`flutter create . --org <org> --project-name <name> --platforms=android`** → `flutter pub get` → `flutter build apk --release` → upload `build/app/outputs/flutter-apk/app-release.apk`.
- The `flutter create .` step is **mandatory when the repo lacks a full Flutter android/ scaffold** (e.g. you hand-wrote a gradle skeleton with `app/src/main` but no manifest). Without it, Gradle fails early with "unsupported" project / missing manifest errors. It is idempotent — existing `lib/`, `pubspec.yaml`, assets are left alone.
- Iterate with the same `gh run` loop; Dart compile errors surface as `lib/main.dart:<line>:<col>: Error: ...` inside the Gradle output — grep `--log-failed` for `Error:|Exception|What went wrong`.
- Common CI failures (full detail in `references/flutter-apk-ci.md`):
  - **AAPT resource linking** `error: resource xml/file_provider_paths not found` — manifest references `@xml/file_provider_paths` but `android/app/src/main/res/xml/file_provider_paths.xml` doesn't exist. Create it (or drop the FileProvider block).
  - **receive_sharing_intent plugin**: do NOT write a custom MainActivity/`ReceiveSharingIntentPlugin.sharedText` — that API doesn't exist; the plugin self-registers via FlutterPlugin. `SharedMediaFile` has NO `.text` getter (share text arrives in `.path` — plugin puts `path ?: text` into the JSON). Activity needs `launchMode="singleTask"` (not singleTop) + `<intent-filter>` ACTION_SEND `text/*`. Use BOTH `getMediaStream()` (warm start) and `getInitialMedia()` + `reset()` (cold start). Verify plugin API by fetching its GitHub source, never by guessing.
  - **Dart null-safety after retry loop**: locals assigned inside a `try { … break; } catch { rethrow on last attempt }` loop stay nullable to the analyzer — force-unwrap `video!` / `manifest!` after the loop.
  - **`Failed host lookup: 'www.youtube.com' (errno = 7)`** on device = DNS failure, not an app bug. Add a 3x retry with delay and a dedicated `on SocketException` catch for a readable `[NETWORK ERROR]` message.

## Support files
- `references/openvpn-embedding.md` — embedding the OpenVPN3 engine (`io.github.tim06:openvpn`) + VPN Gate config source (free, no account).
- `references/compose-ci-debugging.md` — Kotlin/Compose CI error patterns (trailing-lambda binding, internal Modifier.weight, regex-replace double-hit pitfalls).
- `references/flutter-apk-ci.md` — Flutter APK via GitHub Actions: full workflow, share-intent plugin contract, AAPT/Dart-null-safety/DNS fixes from the DebDown+ session.
- `references/debdownplus-flutter-patterns.md` — DebDown+ specific patterns: yt-dlp MethodChannel engine, storage strategy (always Download/), share intent contract, hacker/glitch UI theme, compact single-screen layout, version management, CI debugging loop, common fixes, permission log messages, release URLs.
- `references/debsisten-debugging.md` — DEBSISTEN app specific: GitHub Actions build failures, Kotlin/Compose CI errors, provider dialog fixes, markdown rendering, AiRouter fallback, OpenRouter image base64, AppLogger file logging, provider configuration reference.

## Docs
- Building Android with GitHub Actions: https://docs.github.com/actions/use-cases-and-examples/building-and-testing/building-and-testing-java-with-gradle
