# GitHub Actions Workflow for GSI Building

## Core Workflow (`.github/workflows/build_gsi.yml`)

```yaml
name: Build GSI

on:
  workflow_dispatch:
    inputs:
      android_branch:
        description: 'Android Branch (e.g. android-15.0, android-16.0)'
        required: true
        default: 'android-15.0'
        type: string
      gsi_target:
        description: 'GSI Target (treble_arm64_bvN for GApps, treble_arm64_bgN for Vanilla)'
        required: true
        default: 'treble_arm64_bvN'
        type: string

jobs:
  build-gsi:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      
      - name: Free Disk Space
        run: |
          sudo rm -rf /usr/share/dotnet /opt/gh /usr/local/lib/android /opt/hostedtoolcache
          docker rmi $(docker image ls -aq) 2>/dev/null || true
          sudo apt-get purge -y azure-cli google-cloud-cli microsoft-edge-stable firefox google-chrome-stable 2>/dev/null || true
          sudo apt-get autoremove -y && sudo apt-get clean
          df -h

      - name: Install Dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y git-core gnupg flex bison build-essential zip curl zlib1g-dev \
            libc6-dev libncurses5 lib32ncurses-dev x11proto-core-dev libx11-dev \
            libgl1-mesa-dev libxml2-utils xsltproc unzip fontconfig libssl-dev \
            bc ccache libsoup2.4-dev libarchive-tools python3-pip rsync
          sudo mkdir -p /usr/local/bin
          sudo curl -o /usr/local/bin/repo https://storage.googleapis.com/git-repo-downloads/repo
          sudo chmod a+x /usr/local/bin/repo

      - name: Add Custom ROM Local Manifest
        run: |
          mkdir -p ~/gsi && cd ~/gsi
          mkdir -p .repo/local_manifests
          cat > .repo/local_manifests/debgsi-forks.xml << 'EOF'
          <?xml version="1.0" encoding="UTF-8"?>
          <manifest>
            <!-- Define github remote if not in upstream manifest -->
            <remote name="github" fetch="https://github.com" />
            <project name="<user>/frameworks_base_<name>"
                     path="frameworks/base"
                     remote="github"
                     revision="${{ inputs.android_branch }}" />
            <project name="<user>/packages_apps_SystemUI_<name>"
                     path="packages/apps/SystemUI"
                     remote="github"
                     revision="${{ inputs.android_branch }}" />
            <project name="<user>/packages_apps_Settings_<name>"
                     path="packages/apps/Settings"
                     remote="github"
                     revision="${{ inputs.android_branch }}" />
            <!-- Device overlay and boot animation -->
            <project name="<user>/<device-overlay-repo>"
                     path="vendor/<name>/device-overlay"
                     remote="github"
                     revision="master" />
            <project name="<user>/<bootanimation-repo>"
                     path="vendor/<name>/bootanimation"
                     remote="github"
                     revision="master" />
          </manifest>
          EOF

      - name: Initialize Repo and Sync Source
        run: |
          cd ~/gsi
          # Use Phh-Treble manifest (public, designed for GSI) instead of TrebleDroid (requires auth)
          # or official AOSP manifest with proper local manifests
          repo init -u https://github.com/phhusson/treble_manifest.git -b ${{ inputs.android_branch }} --depth=1
          repo sync -c --no-clone-bundle --no-tags --optimized-fetch --prune --force-sync -j$(nproc)

      - name: Apply Boot Animation
        run: |
          cd ~/gsi
          mkdir -p out/target/product/gsi_arm64/system/media
          cp vendor/debgsi/bootanimation/bootanimation.zip out/target/product/gsi_arm64/system/media/bootanimation.zip

      - name: Build GSI
        run: |
          cd ~/gsi
          . build/envsetup.sh
          lunch ${{ inputs.gsi_target }}-userdebug
          make systemimage -j$(nproc)

      - name: Package & Upload
        run: |
          cd ~/gsi
          mkdir -p output
          find out/target/product/ -name "system.img" -exec cp {} output/ \;
          cd output
          zip -r ../../GSI-${{ inputs.android_branch }}-${{ inputs.gsi_target }}.zip system.img
```

## Key Points (Updated from DEBGSI session)

### Manifest Selection
- **Phh-Treble manifest** (`https://github.com/phhusson/treble_manifest.git`) — public, designed for GSI builds, includes `github` remote and GSI lunch targets (`treble_arm64_bvN`, `treble_arm64_bgN`, etc.)
- **TrebleDroid manifest** (`https://github.com/trebledroid/android_manifest.git`) — requires GitHub auth, fails on public runners
- **Official AOSP manifest** (`https://android.googlesource.com/platform/manifest`) — public but doesn't have `github` remote or GSI targets preconfigured; need to add local manifest for both

### Critical Fixes Applied in This Session
1. **Add `<remote name="github" fetch="https://github.com" />`** to local manifest if upstream doesn't define it
2. **Use `docker rmi $(docker image ls -aq) 2>/dev/null || true`** — fails if no images exist
3. **Use `apt-get purge ... 2>/dev/null || true`** — some packages (like `hh-firefox`) don't exist on all runners
4. **Boot animation** — copy to `out/target/product/gsi_arm64/system/media/bootanimation.zip` AFTER build but BEFORE packaging
5. **Device overlay** — include in local manifest at `vendor/<name>/device-overlay` with SELinux policy

### GSI Targets (Phh-Treble)
- `treble_arm64_bvN` — with GApps (userdebug)
- `treble_arm64_bgN` — Vanilla, no GApps (userdebug)
- `treble_arm64_bvN-userdebug` — full target string for `lunch`

### Disk Space
- GitHub runners: ~70GB available
- AOSP sync: ~100GB+ needed → aggressive cleanup MANDATORY
- Always run cleanup BEFORE installing dependencies

### Device Overlay Structure
```
vendor/<name>/device-overlay/
├── Android.bp
├── overlay/
│   ├── frameworks/base/core/res/res/values/config.xml
│   ├── frameworks/base/packages/SystemUI/res/values/config.xml
│   └── packages/apps/Settings/res/values/config.xml
��── device/phh/treble/sepolicy/device.te
```
Include via local manifest at `vendor/<name>/device-overlay` with `revision="master"`

### Common Failure: "remote github not defined"
- **Cause**: Upstream manifest (TrebleDroid/AOSP) doesn't define `github` remote
- **Fix**: Add `<remote name="github" fetch="https://github.com" />` in local manifest before projects using it

### Common Failure: "manifest 'default.xml' not available"  
- **Cause**: Wrong branch name or manifest doesn't have that branch
- **Fix**: Check available branches at `https://github.com/phhusson/treble_manifest/branches` — use exact branch name like `android-15.0` or `android-16.0`