# Embedding real yt-dlp in a Flutter APK via youtubedl-android (verified 2026-08, DebDown+ v1.3.4)

When the requirement is "download from TikTok/IG/X/FB/SoundCloud/1000+ sites +
playlists + subtitles + MP3" — i.e. beyond what `youtube_explode_dart`
(YouTube-only) can do — bundle the real yt-dlp engine with the
**youtubedl-android** library. It ships yt-dlp + Python 3.8 + FFmpeg compiled
for Android, all inside the AAR. No external downloader needed at runtime;
yt-dlp can even self-update from GitHub inside the app.

## 1. Gradle deps (Maven Central)
```kotlin
implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1") // needed for -x (MP3) and merging
```
Requirements enforced by the library:
- **minSdk 24** (setting 21 fails manifest merger: "minSdkVersion 21 cannot be
  smaller than version 24 declared in library ..."). Set 24 FIRST, don't debug it.
- **`android:extractNativeLibs="true"`** on `<application>` in AndroidManifest.xml.
- Optional: `abiFilters 'armeabi-v7a', 'arm64-v8a', 'x86_64'` to control APK size.
- Reality check: bundled Python + ffmpeg for 3 ABIs → **release APK ≈ 160 MB**.
  Tell the user before they complain.

### 1b. Shrinking the APK: ABI split (the fix users ask for)
The 160 MB is one fat APK holding 3 ABIs. Split per ABI and each APK drops to
~55–60 MB:
```yaml
- name: Build APK Release (split per ABI)
  run: flutter build apk --release --split-per-abi
```
Outputs: `app-arm64-v8a-release.apk`, `app-armeabi-v7a-release.apk`,
`app-x86_64-release.apk` (NOT `app-release.apk` — update artifact paths and
release upload accordingly!). In the release step, copy arm64 to a friendly
`DebDownPlus.apk` (arm64 = virtually all phones 2017+) and attach all three.
arm64 covers Snapdragon 835+/Kirin/Exynos+; keep armeabi-v7a only for legacy
32-bit devices, x86_64 for emulators. Tell the user which file to install —
"PAKAI INI" for the arm64 one.

## 2. Keep native deps alive across `flutter create .`
The CI workflow runs `flutter create .` every build (see flutter-apk-ci.md), which
REGENERATES `android/app/build.gradle` from scratch. The repo must NOT rely on a
tracked build.gradle for native deps — inject them in the workflow AFTER the
create step with a python3 heredoc:
```bash
python3 - <<'PYEOF'
p = 'android/app/build.gradle'
s = open(p).read()
if 'youtubedl' not in s:
    s = s.replace('dependencies {',
        "dependencies {\n"
        "    implementation 'io.github.junkfood02.youtubedl-android:library:0.18.1'\n"
        "    implementation 'io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1'", 1)
    s = s.replace('minSdkVersion flutter.minSdkVersion',
        "minSdkVersion 24\n"
        "        ndk {\n"
        "            abiFilters 'armeabi-v7a', 'arm64-v8a', 'x86_64'\n"
        "        }", 1)
    open(p, 'w').write(s)
PYEOF
```
Idempotent guard (`if 'youtubedl' not in s`) so re-runs don't double-inject.
Note: tracked files under `android/app/src/main/` (AndroidManifest.xml,
MainActivity.kt, res/xml/*) DO survive `flutter create .` — only files the
template owns (build.gradle, etc.) get regenerated.

## 3. Kotlin API (from the library's sample apps)
```kotlin
// init extracts bundled binaries — SLOW & SYNCHRONOUS → background thread!
YoutubeDL.getInstance().init(applicationContext)
FFmpeg.init(applicationContext)                    // only if you added :ffmpeg
YoutubeDL.getInstance().versionName(applicationContext) // e.g. "2026.08.07"

// AUTO-UPDATE from GitHub (the "app opens → checkForUpdates → new yt-dlp" flow)
val status = YoutubeDL.getInstance()
    .updateYoutubeDL(applicationContext, YoutubeDL.UpdateChannel._STABLE)
// status: DONE | ALREADY_UP_TO_DATE | ...; also runs on a worker thread

// DOWNLOAD with progress
val req = YoutubeDLRequest(url)
req.addOption("-o", "$dir/%(title)s.%(ext)s")   // or fixed "$dir/$name.%(ext)s"
req.addOption("--no-mtime"); req.addOption("--newline"); req.addOption("--no-warnings")
req.addOption("--no-playlist")                  // drop for playlist support
// MP3:
req.addOption("-x"); req.addOption("--audio-format", "mp3"); req.addOption("--audio-quality", "0")
// MP4 (video+audio merged by ffmpeg):
req.addOption("-f", "bv*+ba/b"); req.addOption("--merge-output-format", "mp4")

val response = YoutubeDL.getInstance().execute(req, processId) { progress, _, line ->
    // progress: Float 0..100; line: raw yt-dlp stdout line
}
// Cancel: YoutubeDL.getInstance().destroyProcessById(processId)
```
`init()` is guarded internally, but when init/update/download all run on their
own Threads, guard YOUR wrapper with an `AtomicBoolean` + `@Synchronized`
(race → double-extract or crash).

## 4. Bridging to Flutter (MethodChannel + EventChannel)
One MethodChannel for commands, one EventChannel for progress streaming:
```kotlin
val channel = MethodChannel(engine.dartExecutor.binaryMessenger, "debdown/ytdl")
val events = EventChannel(engine.dartExecutor.binaryMessenger, "debdown/ytdl/progress")
```
- `init` → returns **"DONE"** (clean log, no version noise). Version extraction happens internally.
- `update` → runs updateYoutubeDL, fires `{type:'update', status}` event AND resolves **"DONE"**; catch errors and emit `{type:'update', status:'ERROR'}`.
- `download` → spawns Thread, emits `{type:'download', processId, status:'started'}`, then live `{progress: p/100, line}` events, then `{status:'done'}` + resolve. Errors → `{status:'error', error}` event + `result.error(...)`.
- `cancel` → destroyProcessById.
- `defaultDir` → **Always returns `/storage/emulated/0/Download/<AppName>`** (v1.3.3+). Tries mkdirs, lets engine handle permission errors. No fallback chain in code — if permission denied, error surfaces to user who must enable "All files access". UI logs clear permission status at startup.
Dart side: `EventChannel(...).receiveBroadcastStream().listen(...)` set up in
initState; never call `setState` after dispose — guard with `mounted`.

## 5. Clean Engine Logs (v1.3.4+)
To keep user-facing logs clean and branded:

**Kotlin side (MainActivity.kt):**
- `init` returns `"DONE"` (not version)
- `update` returns `"DONE"` (not `status|version`)

**Dart side (lib/main.dart):**
```dart
// Init
final v = await _ytdl.invokeMethod<String>('init');
setState(() => _engineStatus = 'ENGINE DONE');
_log('Engine initialized: DONE');

// Update event handler
if (type == 'update') {
  final status = m['status'] ?? '';
  if (status.contains('DONE') || status.contains('UP_TO_DATE')) {
    setState(() => _engineStatus = 'ENGINE DONE');
    _log('Engine update: DONE');  // Clean, no version noise
  }
}
```

Result log:
```
[2026-08-11 15:46:05] App started v1.3.4
[2026-08-11 15:46:05] Engine initialized: DONE
[2026-08-11 15:46:05] Storage: All Files Access GRANTED — Download/ terbuka
[2026-08-11 15:46:09] Engine update: DONE
```
No `vnull`, no `vyt-dlp 2026.07.04`, no `|yt-dlp 2026.07.04`.

## 6. Pitfalls seen in the field
- Progress callback value is 0–100 (divide by 100 for a 0–1 Flutter progress bar).
- `result` must be resolved exactly once per call — resolve in the success path
  AND in the catch path, or Flutter awaits forever.
- The `line` payload can be huge/ugly ("[download] 45.3% of 25.4MiB at ...");
  show it raw in a terminal-style console widget — it reads as authentic.
- Version-bump discipline with auto-release: bump pubspec version AND the
  in-app version strings in one commit; the workflow tags the release from
  pubspec (`v$(grep '^version:' pubspec.yaml ...)`), so a stale version means a
  buggy APK silently replaces the good release tag.
- App label/icon: keep `<application android:label="DebDown+">` — youtubedl-android
  does not override it.
- **Signing**: Use `r0adkll/sign-android-release@v1` with 4 GitHub secrets
  (`SIGNING_KEY`, `ALIAS`, `KEY_STORE_PASSWORD`, `KEY_PASSWORD`). Install
  build-tools 29.0.3 via `sdkmanager` — the sign action hardcodes this path.
- **Storage**: On Realme/ColorOS/MIUI, `MANAGE_EXTERNAL_STORAGE` (All Files Access)
  is REQUIRED for public Download/ folder. Log clear status at startup.
- **UI centering (Dev tab)**: Use `LayoutBuilder` + `ConstrainedBox(minHeight)` +
  `IntrinsicHeight` + `Column(mainAxisAlignment: center, crossAxisAlignment: start)`
  for vertically centered, left-aligned content that scales on all screen sizes.