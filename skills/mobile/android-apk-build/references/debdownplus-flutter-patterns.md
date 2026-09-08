# DebDown+ Flutter Project Patterns

## Project Overview
Flutter video/audio downloader using native yt-dlp engine via MethodChannel (`youtubedl-android` v0.18.1). Built entirely via GitHub Actions CI.

## Key Technical Decisions

### Engine: Native yt-dlp via MethodChannel
- Package: `youtubedl-android` (v0.18.1) from Maven Central
- MethodChannel: `debdown/ytdl` with methods: `init`, `update`, `defaultDir`, `download`, `shareFile`
- Kotlin side: `MainActivity.kt` handles engine lifecycle, progress events via EventChannel `debdown/ytdl/progress`
- Auto-update yt-dlp binary from GitHub on every app start

### Storage Strategy: Always `/storage/emulated/0/Download/DebDown+`
- User requirement: files MUST appear in standard Download/ folder (file manager visible)
- `defaultDir` handler creates `Download/DebDown+` via `Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)`
- **NO fallback to app-private folders** — if permission denied, let yt-dlp error surface so user sees it and grants "All Files Access"
- Android 11+ (API 30+): requires `MANAGE_EXTERNAL_STORAGE` (declared in manifest)
- Realme/ColorOS (CPH2127 = Realme 7): extremely strict — user MUST manually enable "All files access" in Settings

### Share Intent Integration
- Plugin: `receive_sharing_intent` v1.7.0 (verified from KasemJaffer/receive_sharing_intent)
- Activity: `singleTask` + `<intent-filter>` ACTION_SEND text/*
- Dart: BOTH `getMediaStream()` (warm) + `getInitialMedia()` + `reset()` (cold)
- `SharedMediaFile` has NO `.text` getter — text shares arrive in `.path` field

### UI Theme: Hacker/Glitch
- Colors: bg `#050505`, neon green `#39FF14`, banner `#121826`, icon bg `#071207`, kCyan/kPurple/kOrange
- GlitchBanner (150px): grid + 2 animated scanlines + gradient text `// ⚡ DebDown+` + pulsing subtitle
- Terminal console (150px fixed): syntax highlight (timestamp grey, ERROR red, SUCCESS green, INFO yellow, URL cyan, brand cyan)
- Platform grid: 2×3 glass chips (YT red, TikTok cyan, IG pink, X white, FB blue, SC orange) + "+ 1000 sites"
- Tabs: 🚀 DEVELOPER (glitch), ✨ Debz ✨, ☕ TRAKTIR KOPI 😁 (kOrange, intensity 1.2)

### Compact Layout (v1.3.3+)
- **No AppBar** — GlitchBanner is the header
- Padding: `EdgeInsets.fromLTRB(12, 4, 12, 8)` (was 16 all sides)
- Spacing: gaps reduced 8/6/8/4 (was 16/12/10/20)
- Dev tab: profile 90×90 (was 120), QR 150×150 (was 190), terminal 120px (was 150)
- **Goal: everything fits one screen without scrolling on typical phones**

### Version Management
- Single source: `pubspec.yaml` version (e.g. `1.3.3+1`)
- 4 occurrences in `main.dart` updated via sed:
  - `_statusMessage = 'SYSTEM READY [vX.Y.Z]'`
  - `_statusLog = ['SYSTEM READY [vX.Y.Z]']`
  - `_log('App started vX.Y.Z')`
  - `header = 'DEBDOWN+ vX.Y.Z - SYSTEM LOGS'`

### GitHub Actions Workflow
```yaml
- uses: subosito/flutter-action@v2 (flutter-version: '3.19.x', cache: true)
- run: flutter create . --org com.debdownplus --project-name debdown_plus --platforms=android
- run: flutter pub get
- run: flutter build apk --release --split-per-abi
- sed minSdkVersion 24 in app/build.gradle (required by youtubedl-android v0.18.1)
- uses: r0adkll/sign-android-release@v1 (signingKeyBase64, alias, keyStorePassword, keyPassword from GitHub Secrets)
- softprops/action-gh-release@v2 with --clobber (overwrites existing assets)
```

### APK Signing (v1.3.3+)
- Action: `r0adkll/sign-android-release@v1` after `flutter build apk`
- Keystore: `debdownplus-release.jks` (RSA 2048, 10k days validity, alias `debdownplus`)
- GitHub Secrets: `SIGNING_KEY` (base64 .jks), `ALIAS`, `KEY_STORE_PASSWORD`, `KEY_PASSWORD`
- **Backup `.jks` file permanently** — same key for all future releases
- Result: properly signed release APK, minimal Play Protect warning

### CI Debugging Loop
```bash
# Watch latest run
gh run watch <id> --repo debzroot/debdownplus --exit-status

# On failure, extract errors
gh run view <id> --repo debzroot/debdownplus --log-failed | grep -iE "Error:|Exception|What went wrong"

# Commit+push triggers new run; do NOT re-run manually
```

### Common CI Fixes (from this project)
1. **Missing `flutter create .`** → Gradle "unsupported project" / no manifest
2. **AAPT `xml/file_provider_paths not found`** → create `res/xml/file_provider_paths.xml`
3. **receive_sharing_intent `.text` getter** → use `.path` only; delete custom MainActivity
4. **Dart null-safety after retry loop** → force-unwrap `video!`/`manifest!`
5. **DNS lookup failure (errno=7)** → 3x retry + dedicated SocketException catch
6. **minSdk 24 enforcement** → sed in workflow after `flutter create`

### Permission Log Messages
```dart
if (manage.isGranted) 
  'Storage: All Files Access GRANTED — Download/ terbuka'
else if (storage.isGranted) 
  'Storage: partial (media only) — Download/ butuh All Files Access'
else 
  'Storage: NOT granted — Download/ mungkin gagal (aktifkan All Files Access di Settings)'
```

### Release Artifact URLs
```
https://github.com/debzroot/debdownplus/releases/download/vX.Y.Z/DebDownPlus.apk (universal)
https://github.com/debzroot/debdownplus/releases/download/vX.Y.Z/DebDownPlus-vX.Y.Z-arm64-v8a.apk
https://github.com/debzroot/debdownplus/releases/download/vX.Y.Z/DebDownPlus-vX.Y.Z-armeabi-v7a.apk
https://github.com/debzroot/debdownplus/releases/download/vX.Y.Z/DebDownPlus-vX.Y.Z-x86_64.apk
```

## Files to Remember
- `/tmp/debdownplus/lib/main.dart` — all UI + logic (2340+ lines)
- `/tmp/debdownplus/android/app/src/main/kotlin/com/debdownplus/debdown_plus/MainActivity.kt` — MethodChannel engine
- `/tmp/debdownplus/.github/workflows/build.yml` — CI workflow
- `/tmp/debdownplus/pubspec.yaml` — version + deps