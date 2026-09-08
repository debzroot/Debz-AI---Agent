# Proper APK Signing in GitHub Actions CI (Flutter)

## Problem
Flutter `flutter build apk --release` produces unsigned APKs (debug key). Play Protect shows "App not recognized" warnings on sideload. Proper release signing requires:
- A keystore (RSA 2048-bit, long validity)
- Base64-encoded keystore stored in GitHub Secrets
- Signing step in CI using build-tools (zipalign + apksigner)

## Keystore Generation (one-time, local)
```bash
# Generate keystore
keytool -genkeypair -v -keystore myapp-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias myapp -storepass <STORE_PASS> -keypass <KEY_PASS> \
  -dname "CN=MyApp, OU=MyApp, O=MyOrg, L=City, ST=State, C=ID"

# Encode for GitHub secret (single line, no newlines)
base64 -w 0 myapp-release.jks
```

## GitHub Secrets (4 required)
Set via `gh secret set` or GitHub UI Settings → Secrets → Actions:

| Secret | Example |
|--------|---------|
| `SIGNING_KEY` | `<base64 output from above>` |
| `ALIAS` | `myapp` |
| `KEY_STORE_PASSWORD` | `<STORE_PASS>` |
| `KEY_PASSWORD` | `<KEY_PASS>` |

```bash
gh secret set SIGNING_KEY --repo owner/repo --body "$(base64 -w 0 myapp-release.jks)"
gh secret set ALIAS --repo owner/repo --body "myapp"
gh secret set KEY_STORE_PASSWORD --repo owner/repo --body "<STORE_PASS>"
gh secret set KEY_PASSWORD --repo owner/repo --body "<KEY_PASS>"
```

## CI Workflow (Flutter)
```yaml
- name: Set up Flutter
  uses: subosito/flutter-action@v2
  with:
    flutter-version: '3.19.x'
    channel: 'stable'
    cache: true

# IMPORTANT: r0adkll/sign-android-release@v1 expects build-tools 29.0.3
- name: Set up Android SDK (for zipalign/apksigner)
  uses: android-actions/setup-android@v3
  with:
    api-level: 34
    build-tools-version: '29.0.3'  # <-- MUST match what sign action expects
    emulator: false

- name: Initialize Flutter Project Scaffolding
  run: flutter create . --org com.myorg --project-name myapp --platforms=android

- run: flutter pub get
- run: flutter build apk --release --split-per-abi

# Sign APKs (requires the 4 secrets above)
- name: Sign APKs
  uses: r0adkll/sign-android-release@v1
  with:
    releaseDirectory: build/app/outputs/flutter-apk
    signingKeyBase64: ${{ secrets.SIGNING_KEY }}
    alias: ${{ secrets.ALIAS }}
    keyStorePassword: ${{ secrets.KEY_STORE_PASSWORD }}
    keyPassword: ${{ secrets.KEY_PASSWORD }}

- name: Upload APK Artifacts
  uses: actions/upload-artifact@v4
  with:
    name: MyApp-Release
    path: build/app/outputs/flutter-apk/app-*-release.apk
```

## Common Pitfall: Build-tools version mismatch
The `r0adkll/sign-android-release@v1` action **hardcodes** search for `/usr/local/lib/android/sdk/build-tools/29.0.3/zipalign`.

If `android-actions/setup-android@v3` installs a different version (e.g., 30.0.3 or 34.0.0), signing fails with:
```
Couldnt find the Android build tools @ /usr/local/lib/android/sdk/build-tools/29.0.3
Unable to locate executable file: .../29.0.3/zipalign
```

**Fix**: Explicitly set `build-tools-version: '29.0.3'` in the `setup-android` step.

## Verify signing worked
```bash
# Check APK is signed (not debug key)
unzip -p app-arm64-v8a-release.apk META-INF/CERT.RSA | keytool -printcert | grep -i "owner\|issuer"
# Should show your CN=MyApp, not "CN=Android Debug"
```

## Backup keystore
Store `myapp-release.jks` + passwords in a password manager / secure location.
**Never regenerate** — all future updates must use the same key, or users must uninstall before updating.