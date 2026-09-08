# APK Build via GitHub Actions — CI Lessons

Working workflow shape (`assembleDebug` + artifact upload):

```yaml
on:
  push: { branches: [main] }
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
          name: debnetplus-v0.1.${{ github.run_number }}
          path: app/build/outputs/apk/debug/*.apk
```

## Versioning (the "always installs old APK" trap)

- Android uses `versionCode` to decide upgrades. Identical versionCode → install silently rejected / old APK kept. Users then report "your fixes aren't there" when they actually installed a stale artifact.
- **GitHub Actions checkout is shallow (depth 1)** → `git rev-list --count HEAD` returns 1 forever. Use the Actions env var instead:

```kotlin
val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
versionCode = buildNumber
versionName = "6.6.6"          // or "0.1.$buildNumber"
```

- Name the artifact with the run number so users can tell builds apart; show version in-app (inside a DEV screen, not the header, per user preference) and stamp it in the log file header.

## Other gotchas

- **AGP 8+ disables BuildConfig by default** — `buildConfig = true` must be added to `buildFeatures`, or `BuildConfig.VERSION_NAME` won't compile.
- `Unable to strip ... libovpn3.so` in build logs is a harmless warning (prebuilt native lib).
- Verify what actually got installed: version stamp in log file line 1 + in-app subtitle. When a user reports "still broken" with old-behavior logs, check the log header version before touching code — it's often a stale APK, not a stale fix.
- Debug signing: `assembleDebug` uses the auto-generated debug keystore, so every APK is installable. For release APKs you'd need a real keystore via GitHub secrets.
