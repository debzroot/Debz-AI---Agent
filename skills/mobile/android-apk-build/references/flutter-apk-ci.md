# Flutter APK via GitHub Actions — patterns from the DebDown+ session

## Context
User wanted an Android APK for a Flutter app (video downloader "DebDown+" using `youtube_explode_dart`). No Flutter/Gradle on the host → build entirely in GitHub Actions, APK delivered as an artifact. Session debugged 4 consecutive CI failures; each fix below is the exact error + root cause + fix that produced a green build.

## Known-good workflow skeleton
```yaml
name: Build APK
on:
  push: { branches: [ main ] }
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4   # v4 deprecated; v5 is current
        with: { distribution: zulu, java-version: '17' }
      - uses: subosito/flutter-action@v2
        with: { flutter-version: '3.19.x', channel: stable, cache: true }
      - run: flutter create . --org com.example --project-name my_app --platforms=android
      - run: flutter pub get
      - run: flutter build apk --release
      - uses: actions/upload-artifact@v4
        with: { name: Release, path: build/app/outputs/flutter-apk/app-release.apk }
```
Artifact fetch: `gh run download <id> --repo owner/repo --dir out` → `out/<ArtifactName>/app-release.apk`.

## Failure 1 — repo pushed without a Flutter scaffold
Symptom: build fails almost immediately, Gradle "unsupported" project / no `AndroidManifest.xml` anywhere in the repo.
Root cause: project directory was hand-created (`lib/`, `pubspec.yaml`, `assets/`) but never went through `flutter create` — no `android/` scaffold, no manifest, no `MainActivity`.
Fix: add `flutter create . --org ... --project-name ... --platforms=android` as a workflow step before `flutter pub get`. It is idempotent: an existing `lib/main.dart`, `pubspec.yaml`, and `assets/` survive untouched; it only generates the missing platform scaffolding.

## Failure 2 — AAPT resource linking: `xml/file_provider_paths not found`
Symptom:
```
> Task :app:processReleaseResources FAILED
Android resource linking failed
.../AndroidManifest.xml:105: error: resource xml/file_provider_paths
(aka com.example.app:xml/file_provider_paths) not found.
error: failed processing manifest.
```
Root cause: hand-written `AndroidManifest.xml` declared a `FileProvider` pointing at `@xml/file_provider_paths` but `android/app/src/main/res/xml/file_provider_paths.xml` was never created.
Fix: create the file
```xml
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <files-path name="files" path="." />
    <cache-path name="cache" path="." />
    <external-path name="external" path="." />
</paths>
```
(or remove the `<provider>` block entirely if no FileProvider is needed). Lesson: any `@xml/...`, `@drawable/...`, `@style/...` referenced in a hand-written manifest must exist under `res/` or AAPT fails at link time.

## Failure 3 — receive_sharing_intent: no `.text` getter on SharedMediaFile
Symptom (Dart compile error):
```
lib/main.dart:105:56: Error: The getter 'text' isn't defined for the class 'SharedMediaFile'.
```
Root cause: `SharedMediaFile` (plugin v1.9.0) has no `text` field. The plugin serializes shares into one JSON object where **text shares land in the `path` field**: `JSONObject().put("path", path ?: text)` (verified in `ReceiveSharingIntentPlugin.toJsonObject`). So for a `text/plain` share, `value.first.path` holds the URL.
Fix: read `value.first.path ?? ''` only. Also: a hand-written `MainActivity.kt` referencing `ReceiveSharingIntentPlugin.sharedText` must be DELETED — that API does not exist, and the plugin self-registers via `FlutterPlugin`/`ActivityAware` (it hooks `onNewIntent` itself), so a custom MainActivity is unnecessary and the file only caused compile risk.

## Failure 4 — Dart null-safety after a retry loop
Symptom:
```
Error: Property 'title' cannot be accessed on 'Video?' because it is potentially null.
```
Root cause: refactored fetch into `Video? video; for (attempt...) { try { video = await ...; break; } catch { rethrow on last } }` — the analyzer keeps locals nullable even though the loop guarantees assignment (last attempt rethrows).
Fix: force-unwrap once after the loop:
```dart
final resolvedVideo = video!;
final resolvedManifest = manifest!;
```
then use the resolved locals.

## Runtime issue — `Failed host lookup: 'www.youtube.com' (OS Error: No address associated with hostname, errno = 7)`
This is a device DNS/network failure, not an app bug (can be transient ISP/regional DNS blocking). Don't chase it as a code bug. App-side hardening:
- Wrap the fetch in 3 attempts with `await Future.delayed(Duration(seconds: 2))` between them.
- Add a dedicated `on SocketException catch (e)` before the generic `catch` so the user sees `[NETWORK ERROR] DNS lookup failed: ...` instead of a raw `ClientException` dump.

## receive_sharing_intent contract (v1.9.0, verified from source)
- Repo: `KasemJaffer/receive_sharing_intent` (find via pub.dev API `https://pub.dev/api/packages/<pkg>` → `latest.pubspec.homepage`, then list files via `https://api.github.com/repos/<owner>/<repo>/git/trees/master?recursive=1`).
- Plugin package id on Android: `com.kasem.receive_sharing_intent` (NOT `com.omkarmoghe` — old docs/posts are stale).
- Channels: `receive_sharing_intent/messages` (getInitialMedia/reset), `.../events-media`, `.../events-text`.
- Dart side needs BOTH:
  - `ReceiveSharingIntent.instance.getMediaStream().listen(...)` — fires when app is already open and a share arrives (`onNewIntent` → `handleIntent(intent, false)`).
  - `ReceiveSharingIntent.instance.getInitialMedia().then(...)` + `.reset()` — cold start via share.
- Manifest: activity `android:launchMode="singleTask"` (README: singleTask, NOT singleTop — singleTop creates a new activity per intent otherwise) + intent-filter:
```xml
<intent-filter>
  <action android:name="android.intent.action.SEND" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="text/*" />
</intent-filter>
```
- Plugin's `onAttachedToActivity` calls `handleIntent(binding.activity.intent, true)` itself — no custom activity code needed.

## General CI loop notes
- Each push auto-triggers a workflow run — commit+push is the iterate cycle; `workflow_dispatch` only for manual re-runs.
- `gh run watch <id> --repo owner/repo --exit-status` blocks until done (exit code mirrors build status).
- On failure: `gh run view <id> --repo owner/repo --log-failed | grep -iE "Error:|Exception|What went wrong"`.
- Older `gh` versions reject `--json artifacts` (field list printed on error) — just use `gh run download <id>`.

## APK Signing with r0adkll/sign-android-release (DebDown+ v1.3.3+)

To avoid Play Protect "debuggable app" warnings and produce a properly signed release APK:

### Workflow step (add after `flutter build apk`):
```yaml
- name: Sign APKs
  uses: r0adkll/sign-android-release@v1
  with:
    releaseDirectory: build/app/outputs/flutter-apk
    signingKeyBase64: ${{ secrets.SIGNING_KEY }}
    alias: ${{ secrets.ALIAS }}
    keyStorePassword: ${{ secrets.KEY_STORE_PASSWORD }}
    keyPassword: ${{ secrets.KEY_PASSWORD }}
```

### Generate keystore once (keep FOREVER — same key for all future updates):
```bash
keytool -genkeypair -v -keystore debdownplus-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias debdownplus \
  -storepass DebDownPlus2026! -keypass DebDownPlus2026! \
  -dname "CN=DebDownPlus, OU=DebDownPlus, O=Debz, L=Jakarta, ST=DKI, C=ID"
```

### Convert to base64 and set GitHub Secrets (via `gh` CLI):
```bash
# SIGNING_KEY (base64 of .jks file)
gh secret set SIGNING_KEY --repo debzroot/debdownplus --body "$(cat debdownplus-release.jks | base64 -w 0)"

# The other 3 secrets
gh secret set ALIAS --repo debzroot/debdownplus --body "debdownplus"
gh secret set KEY_STORE_PASSWORD --repo debzroot/debdownplus --body "DebDownPlus2026!"
gh secret set KEY_PASSWORD --repo debzroot/debdownplus --body "DebDownPlus2026!"
```

### Critical: Back up the `.jks` file!
- Store the generated `.jks` file in a safe place (Drive, USB, password manager).
- **NEVER regenerate** — the same key must sign every future release, otherwise:
  - Users must uninstall before installing update
  - Play Protect treats it as a completely new/unknown app
  - All trust history is lost

### Result:
- APK signed with proper release key (not debug key)
- Play Protect warning is minimal ("app not recognized" rather than "debuggable")
- Subsequent updates signed with same key build trust over time
- `--clobber` in release upload overwrites old assets with new signed APKs
