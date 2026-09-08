---
name: android-apk-ci-build
description: "Build Android APKs headlessly via GitHub Actions."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [android, apk, gradle, compose, github-actions, openvpn]
    category: software-development
---

# Android APK Build via GitHub Actions (headless)

## When to Use
- User wants an Android APK but there's no Android Studio / SDK on the machine (typical: Termux chroot, VPS, or any headless Debian/Ubuntu).
- User wants APK builds triggered by git push, "build from zero".
- App is **Flutter** (not raw Gradle): same headless-CI pattern, but see
  `references/flutter-apk-ci.md` — flutter create scaffolding, package-name path,
  FileProvider resource, share-intent filters, kotlin-stdlib conflicts, and
  youtube_explode_dart API quirks.

## Core Decision
Do NOT install Android SDK/Gradle on the server — build in GitHub Actions instead. The ubuntu-latest runner is x86_64 with the Android SDK preinstalled; builds in minutes. The server only hosts source + workflow; the APK comes back as an Actions artifact.

## Project Skeleton (Kotlin + Jetpack Compose)
```
repo/
├─ settings.gradle.kts          # pluginManagement repos (google, mavenCentral, gradlePluginPortal); rootProject.name; include(":app")
├─ build.gradle.kts             # plugins { com.android.application 8.5.2 apply false; org.jetbrains.kotlin.android 1.9.24 apply false }
├─ gradle.properties            # org.gradle.jvmargs=-Xmx2048m, android.useAndroidX=true, android.nonTransitiveRClass=true
├─ gradlew + gradle/wrapper/    # wrapper bootstrap, see below
├─ .github/workflows/build.yml
└─ app/
   ├─ build.gradle.kts
   └─ src/main/AndroidManifest.xml + java/... + res/...
```

## Version Pairings That Work (verified 2026-08)
- AGP 8.5.2 + Kotlin 1.9.24 + composeCompilerExtension 1.5.14 + Gradle 8.7
- compileSdk 35, minSdk 26, targetSdk 35; Java 17 (source/target + jvmTarget)
- Compose BOM 2024.09.03; material3; material-icons-extended
- `packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }` (avoids duplicate LICENSE errors)

## Gradle Wrapper Without Local Gradle
Fetch the wrapper from the Gradle repo itself (no local gradle needed):
```bash
curl -sSL -o gradle/wrapper/gradle-wrapper.jar https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar
curl -sSL -o gradlew https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradlew
chmod +x gradlew
# gradle/wrapper/gradle-wrapper.properties: distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-bin.zip
```

## CI Workflow Essentials
```yaml
on: { push: { branches: [main] }, workflow_dispatch: {} }
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-java@v4 { distribution: temurin, java-version: "17" }
  - uses: gradle/actions/setup-gradle@v4
  - run: chmod +x gradlew
  - run: ./gradlew assembleDebug --no-daemon
  - uses: actions/upload-artifact@v4 { name: apk, path: app/build/outputs/apk/debug/*.apk }
  # tagged releases: softprops/action-gh-release@v2 with files: app/build/outputs/apk/debug/*.apk
```
If you create releases with the `gh` CLI instead of a marketplace action:
`gh release create "$TAG" apk --repo "$GITHUB_REPOSITORY"` fails with
**HTTP 403 "Resource not accessible by integration"** unless the job declares
`permissions: contents: write`. Add it at job level; then `gh release create ...`
(or `gh release upload ... --clobber` on re-run) works with the default
`GITHUB_TOKEN`.

## Build Order
1. Debug build first (`assembleDebug`) — unsigned, no keystore needed. Installable as-is.
2. Signed release later: generate keystore, base64 it into a GitHub secret, read from env in signingConfigs.

## Pitfalls
- **Stream timeouts**: writing several big project files in ONE message (or one huge write_file) can time out the tool stream mid-delivery. Write ONE file per tool call; keep each call's args under ~8K tokens.
- `gradlew` without +x on CI → "Permission denied"; always `chmod +x gradlew`.
- Use `--no-daemon` in CI.
- AARs shipping `jni/<abi>/lib*.so` bundle automatically into the APK — no extra packaging config.
- Verify: `gh run watch <id> --repo owner/repo --exit-status`; then download the artifact and `unzip -l app-debug.apk | grep lib/` to confirm native libs are inside.
- **`ndk.abiFilters` + `flutter build apk --split-per-abi` = build failure** ("Conflicting configuration ... cannot be present when splits abi filters are set"). Mutually exclusive; drop the abiFilters block, keep only minSdk.
- **Maven Central HTTP 429 "Too Many Requests" mid-build** is transient (seen on a rerun of the same commit): just `gh run rerun <id> --repo owner/repo` — do NOT change code or "fix" dependencies for a 429.
- **Bracket-balance checks**: naive `s.count('{') == s.count('}')` false-positives on strings containing brackets (regex `[^\]]*` etc.). Use `scripts/check_brackets.py` — a tokenizer that strips string literals and comments before counting.
- **After any build, deliver only the download link** (GitHub Release asset URL); never download the APK locally (see user preferences below).
- **Release tag = pubspec version — bump it in the same commit as feature work.** If the workflow derives `$TAG` from `version:` in pubspec.yaml and you forgot to bump, the build succeeds but the `--clobber` upload silently overwrites the OLD release's assets and no new release/link appears (`gh api .../releases/tags/<tag>` → 404). Bump pubspec + in-app version strings together; verify the tag after build (see `references/flutter-apk-ci.md` §13).

## Launcher icons (adaptive + Android 13 themed icons)
User asked for an icon that "support themed material (ada foreground imagenya)".
Generate everything programmatically (no design tool needed):
- `scripts/gen_icons.py` renders legacy PNGs (5 densities, ic_launcher +
  ic_launcher_round) AND vector `ic_launcher_foreground.xml` +
  `ic_launcher_monochrome.xml` (bolt + glow, 108dp viewport, art inside the
  ~66dp safe zone). Requires pillow (`pip install --break-system-packages pillow`).
- Write `res/mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`:
  `<adaptive-icon>` with `<background android:drawable="@color/ic_launcher_background"/>`,
  `<foreground @drawable/ic_launcher_foreground/>`, and
  `<monochrome @drawable/ic_launcher_monochrome/>` — the **monochrome layer is
  what makes the icon follow wallpaper theme colors on Android 13+**.
- `res/values/colors.xml`: `<color name="ic_launcher_background">#071207</color>`.
- Manifest keeps `android:icon="@mipmap/ic_launcher"` — the anydpi-v26 resource
  is picked up automatically on API 26+, legacy PNGs below.
- Preview before committing: render the xxxhdpi PNG, resize to ~320px, and
  vision_analyze it (bolt centered? contrast OK?).

## Android storage permissions (scoped storage, downloaders)
Download-to-public-Dir apps die on `[Errno 13] Permission denied: '/storage/emulated/0/Download/<App>'`
when All Files Access (MANAGE_EXTERNAL_STORAGE, Android 11+) isn't granted — especially on
Chinese-OEM skins (Realme/ColorOS strictest). **Never trust `mkdirs()`/exists — verify with a probe
file create+delete**, then fall back: public Download → `getExternalFilesDir(...)` (always writable,
hidden on Android 11+, wiped on uninstall) → `cacheDir`. Emit a `{type:'dir', fallback, path}`
EventChannel event so the UI logs where files actually landed; log permission status at startup;
offer SHARE via FileProvider to rescue files out of the hidden app dir. Full pattern + Kotlin/Dart
snippets: `references/android-storage-permissions.md`.

## Support files
- `references/openvpn-embed.md` — embedding an OpenVPN engine in an Android app (Maven Central reality check, engine API contract, VpnService pattern, VPN Gate free-source API).
- `references/flutter-apk-ci.md` — Flutter flavor of the headless CI build: `flutter create` scaffolding step, package-name derivation (org+name → com.<org>.<name>), FileProvider `res/xml` resource, share-intent filters + receive_sharing_intent v1.9.0 gotchas, share_plus kotlin-stdlib duplicate-class conflict (hand-rolled MethodChannel fix), youtube_explode_dart API quirks (muxed streams, qualityString/audioCodec), and UTF-16LE APK manifest verification.
- `references/ytdl-android-embed.md` — bundling the REAL yt-dlp engine (TikTok/IG/1000+ sites, playlists, MP3, in-app auto-update) via `io.github.junkfood02.youtubedl-android` into a Flutter app: minSdk 24, `extractNativeLibs`, build.gradle injection after `flutter create`, init/update/execute API (clean "DONE" logs), MethodChannel + EventChannel bridge, ABI split, proper signing, vertically-centered Dev tab pattern.
- `references/user-ui-preferences.md` — Debz's UI corrections for Flutter iterations: centered dialogs, compact buttons, fixed-height terminal panel, outer-container borders, syntax-highlight colors table, persistent-SOLID completion overlay (no auto-hide, CLOSE button), and the Compose GlitchBanner header port (scanline/gradient/pulse math).
- `references/android-storage-permissions.md` — scoped storage / All Files Access reality (Android 10/11+, OEM skins), the probe-write verification pattern (mkdirs silently succeeds without permission), the writable-dir fallback chain (public Download → getExternalFilesDir → cacheDir) with `{type:'dir'}` EventChannel event, startup permission logging, and the FileProvider SHARE escape hatch for files stuck in the hidden app dir.
- `references/apk-signing-ci.md` — proper release signing in GitHub Actions: keystore generation, 4 GitHub secrets, `r0adkll/sign-android-release@v1` step, build-tools 29.0.3 version pin, verification, and backup procedure.
- `references/app-auto-update-checker.md` — in-app GitHub Release auto-update checker: fetches latest release via GitHub API at startup, compares semver, shows orange badge in terminal header, auto-downloads arm64 APK on tap, opens Android installer via existing shareFile MethodChannel. Includes version-compare logic, rate-limit handling, and UI integration pattern.
- `references/kotlin-android-compilation-pitfalls.md` — Kotlin/Android compilation errors encountered and their fixes (Gson type inference, val/var confusion, missing AccessibilityService constants, Color.copy, duplicate classes, inner class ViewHolders, CoroutineScope.cancel, Material3 vs MaterialComponents parents, deprecated APIs, FAIL_ON_PROJECT_REPOS, ABI splits, XML escaping, missing resources, accessibility config).
- `scripts/gen_icons.py` — launcher icon generator (adaptive vector + monochrome + legacy PNGs), see "Launcher icons" section.
- `scripts/check_brackets.py` — bracket-balance checker that strips string literals/comments (naive counts false-positive on regex strings).

## User preferences (Debz, Indonesian-speaking)
- After a successful APK build, **do NOT download the APK to the machine** —
  deliver the download link (GitHub Release asset or Actions artifact URL) and
  let the user fetch it themselves.
- **During UI/feature iteration, do NOT push or trigger a build** until the user
  explicitly says to ("jgn dulu build ke github / tunggu instruksi dari saya").
  Make local edits only; the user reviews the diff and approves the build.
- **Branding: never show the underlying engine name in the app UI.** User
  explicitly asked to replace every "yt-dlp / vyt-dlp / YT-DLP" string with
  their brand "⚡DebDown+" (including status lines like "⚡DebDown+
  downloading..."). Their products are branded; engine internals stay out of
  user-visible text (comments/log internals are fine).
- UI briefs for this user: hacker/terminal aesthetic — black `#050505`, neon
  green `#39FF14`, purple `#AF82FF`, glitch RGB-split headers, glassmorphism
  panels (backdrop blur + green glow border), scanlines/CRT cursor. Match their
  web project's `base.css` when referenced.
- **UI font: Saira** (their web uses `font-family: 'Saira'`). Bundle the variable
  font from google/fonts (`Saira[wdth,wght].ttf`) and declare it in pubspec with
  multiple `weight:` entries pointing at the same variable file; `monospace`
  only for terminal/log consoles.
- **Header banner — port the Compose `GlitchBanner` pattern** (user: header
  "// ⚡DEBDOWN+ ENGINE ..." was "kayak biasa aja monoton, check New_file.txt").
  When the user shares Compose/Kotlin effect code, port it 1:1 to Flutter:
  solid `#121826` rounded container (16dp) + cyan 50% border; cyan-8% grid every
  30px; TWO animated scanlines with sin motion — `y1 = 20 + (h-40)*(0.5 +
  0.5*sin(t*2π))` (green, 2.5px) and `y2 = 20 + (h-40)*(0.5 + 0.5*sin(t*3π +
  1.5))` (purple, 2px); title via `ShaderMask` linear gradient green→cyan→purple
  ("// ⚡ DebDown+"); subtitle pulsing `opacity = 0.7 + 0.3*sin(t*4π)`
  ("🚀 Video / Audio Downloader 🔥", orange); 3s repeat loop.
- **Developer/donation panel wording**: title "🚀 DEVELOPER" (glitch), dev name
  "✨ Debz ✨", donation CTA "☕ TRAKTIR KOPI 😁" in orange WITH the same glitch
  effect as the title — user renamed these explicitly; don't revert to
  "[DEV] & DONATION PANEL" / "debzroot (Developer)" / "Traktir Kopi ...".
- **Loading & completion animations** (user: "buat effect loading ... lebih keren
  professional"): while downloading show a hacker panel — animated progress ring
  (sweep-gradient arc + rotating ticks + head dot + big %), equalizer bars,
  corner HUD brackets, live yt-dlp line.
- **Completion overlay — do NOT auto-dismiss, SOLID background** (user later
  corrected the first version: "effect selesai downloadnya agak weird ya, dan
  langsung ilang ... jgn lgsung hilang biar bisa dilihat dan di pencet close.
  jgn transparent jg jadi agak berantakan"). So: NO auto-hide timer, NO
  transparent/glass barrier (a solid `#050505` full-screen barrier + solid card
  `#0D160D` with green border/glow), elastic pop-in (~900ms), show the real
  saved path, and a compact **CLOSE** button that the user presses. Drop the
  green flash + particle burst — user found them weird.
- **Layout: no dead space.** Keep the top spacer tiny (~8px) so the hero banner sits right under the status bar; fill leftover space BELOW the terminal with a supported-platform icon grid (brand colors + glow: YT/TikTok/IG/X/FB/SoundCloud + "+ 1000 situs lainnya") so tall screens don't end with an empty tail (see `references/user-ui-preferences.md`).
- Communicate replies in Indonesian (mixed casual tone is fine).
