# Flutter + youtubedl-android Integration Reference

## Overview
This documents the pattern for embedding `youtubedl-android` (native yt-dlp + ffmpeg binaries for ARM) into a Flutter app via MethodChannel. Based on DebDown+ development.

## Key Components

### 1. Dependencies (pubspec.yaml)
```yaml
dependencies:
  flutter:
    sdk: flutter
  path_provider: ^2.1.2
  permission_handler: ^11.3.0
  receive_sharing_intent: ^1.8.1
  http: ^1.2.0
  shared_preferences: ^2.2.2
  photo_view: ^0.14.0
```

### 2. Android build.gradle Patching (in CI)
The `android/` folder is NOT committed; `flutter create .` regenerates it each CI run. Must patch `android/app/build.gradle`:

```python
# In workflow step:
python3 - <<'PYEOF'
p = 'android/app/build.gradle'
s = open(p).read()
if 'youtubedl' not in s:
    s = s.replace(
        'dependencies {',
        "dependencies {\n"
        "    implementation 'io.github.junkfood02.youtubedl-android:library:0.18.1'\n"
        "    implementation 'io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1'",
        1,
    )
    s = s.replace(
        'minSdkVersion flutter.minSdkVersion',
        "minSdkVersion 24",  # REQUIRED by youtubedl-android v0.18.1
        1,
    )
    open(p, 'w').write(s)
PYEOF
```

### 3. MainActivity.kt (MethodChannel Handler)
Package must match: `com.debdownplus.debdown_plus` (from `flutter create --org com.debdownplus --project-name debdown_plus`)

Key methods:
- `init` — Extracts bundled yt-dlp/ffmpeg binaries on first run (async, returns "DONE")
- `update` — Auto-updates yt-dlp from GitHub stable channel (async, returns "DONE")
- `defaultDir` — Returns `/storage/emulated/0/Download/DebDown+` (tries mkdirs, lets engine handle permission errors)
- `download` — Executes YoutubeDLRequest with format options (mp4: `-f bv*+ba/b --merge-output-format mp4`, mp3: `-x --audio-format mp3 --audio-quality 0`)
- `shareFile` — Shares log file via FileProvider

Progress events via `EventChannel` (`debdown/ytdl_progress`): `type=download`, `progress=0.0-1.0`, `line` (raw yt-dlp output)

### 4. AndroidManifest.xml Essentials
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE"
    tools:ignore="ScopedStorage"/>
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
    android:maxSdkVersion="32"/>
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"
    android:maxSdkVersion="29"/>

<application ...>
    <activity
        android:name=".MainActivity"
        android:exported="true"
        android:launchMode="singleTask"
        android:theme="@style/LaunchTheme">
        <intent-filter>
            <action android:name="android.intent.action.MAIN"/>
            <category android:name="android.intent.category.LAUNCHER"/>
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND"/>
            <category android:name="android.intent.category.DEFAULT"/>
            <data android:mimeType="text/plain"/>
        </intent-filter>
    </activity>

    <provider
        android:name="androidx.core.content.FileProvider"
        android:authorities="${applicationId}.fileprovider"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_provider_paths"/>
    </provider>
</application>
```

### 5. res/xml/file_provider_paths.xml
```xml
<paths>
    <files-path name="files" path="."/>
    <cache-path name="cache" path="."/>
    <external-path name="external" path="."/>
    <external-files-path name="external_files" path="."/>
    <external-cache-path name="external_cache" path="."/>
</paths>
```

### 6. CI/CD Workflow (.github/workflows/build.yml)
Key steps:
1. `actions/checkout@v4`
2. `actions/setup-java@v4` (temurin 17)
3. `subosito/flutter-action@v2` (3.19.x stable)
4. `android-actions/setup-android@v3` (api-level 34, build-tools 30.0.3)
5. **Install build-tools 29.0.3** (required by `r0adkll/sign-android-release`):
   ```yaml
   - run: yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager "build-tools;29.0.3" > /dev/null
   ```
6. `flutter create . --org com.debdownplus --project-name debdown_plus --platforms=android`
7. Patch build.gradle (see step 2)
8. `flutter pub get`
9. `flutter build apk --release --split-per-abi`
10. **Sign APKs**: `r0adkll/sign-android-release@v1` with secrets:
    - `SIGNING_KEY` (base64 keystore)
    - `ALIAS` (debdownplus)
    - `KEY_STORE_PASSWORD`
    - `KEY_PASSWORD`
11. `actions/upload-artifact@v4` + `gh release create/upload --clobber`

### 7. Secrets for Signing (GitHub Actions → Settings → Secrets → Actions)
Generate keystore once:
```bash
keytool -genkeypair -v -keystore debdownplus-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias debdownplus \
  -storepass YourPass2026! -keypass YourPass2026! \
  -dname "CN=DebDownPlus, OU=DebDownPlus, O=YourOrg, L=City, ST=State, C=ID"
base64 -w 0 debdownplus-release.jks  # → SIGNING_KEY
```
Store 4 secrets: `SIGNING_KEY`, `ALIAS`, `KEY_STORE_PASSWORD`, `KEY_PASSWORD`

### 8. Adaptive Icons (Android 13+ Themed Icon Support)
- `res/mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` with `<monochrome>` reference
- `res/drawable/ic_launcher_foreground.xml` (vector)
- `res/drawable-anydpi/ic_launcher_monochrome.xml` (vector, single color)
- `res/values/colors.xml` with `ic_launcher_background` (#071207)

### 9. Common Pitfalls & Fixes

| Issue | Fix |
|-------|-----|
| `minSdkVersion` error (youtubedl-android needs 24) | Force `minSdkVersion 24` in build.gradle patch |
| `zipalign` / `apksigner` not found in sign action | Install build-tools 29.0.3 via sdkmanager |
| `SharedMediaFile` has no `.text` getter (v1.9.0) | Use `value.first.path ?? ''` |
| Duplicate class `kotlin-stdlib` (share_plus vs Flutter template) | Remove `share_plus`, use custom MethodChannel `shareFile` |
| Download to `/Download/` fails on Realme/ColorOS | Require "All files access" (MANAGE_EXTERNAL_STORAGE); log clear status |
| Engine init returns `vnull` then updates | Normal — bundled version extracted first, then auto-updates |
| APK not signed / Play Protect warning | Use `r0adkll/sign-android-release` with proper keystore |

### 10. Testing on Device
- Share intent: YouTube/TikTok/IG → Share → DebDown+ → auto-injects link
- Logs visible in app: Terminal tab (downloader) + SYSTEM LOGS tab (dev)
- Share logs: Dev tab → SHARE LOGS.TXT → sends via FileProvider

---

## Version History
- v1.3.3: Proper signing, compact UI, storage always Download/
- v1.3.4: Clean engine logs (DONE only), centered Dev tab