# Fork Repositories Setup for Custom ROM Features

## Create Private Forks (One-time Setup)

Create these private repositories in your GitHub account:

| Component | Repo Name | Source Tree Path | Branch |
|-----------|-----------|------------------|--------|
| Framework | `frameworks_base_<name>` | `frameworks/base` | `android-15.0` |
| SystemUI | `packages_apps_SystemUI_<name>` | `packages/apps/SystemUI` | `android-15.0` |
| Settings | `packages_apps_Settings_<name>` | `packages/apps/Settings` | `android-15.0` |

## Initialize Each Fork

```bash
# Example for frameworks_base_<name>
gh repo create <user>/frameworks_base_<name> --private --description "DEBGSI: Fork of frameworks/base with custom ROM features"
cd /tmp && rm -rf frameworks_base_<name>
git clone https://github.com/<user>/frameworks_base_<name>.git
cd frameworks_base_<name>
git checkout -b android-15.0
echo 'build = ["Android.bp"]' > Android.bp
git add . && git commit -m "Initial commit: Android.bp for Soong recognition"
git push origin android-15.0

# Repeat for SystemUI and Settings
```

## Minimal Android.bp Required

Each fork MUST have an `Android.bp` at root for Soong to recognize it:
```
build = ["Android.bp"]
```

---

## Adding Features: Two Approaches

### A. Cherry-pick from Custom ROMs (Recommended)

```bash
# Statusbar clock styles from crDroid
cd frameworks_base_<name>
git fetch https://github.com/crdroidandroid/frameworks_base.git 15.0
git cherry-pick <commit-hash>  # or range: git cherry-pick A..B

# SystemUI battery styles from Evolution X
cd packages_apps_SystemUI_<name>
git fetch https://github.com/Evolution-X/packages_apps_SystemUI.git 15
git cherry-pick <commit-hash>

# Settings custom categories from DerpFest
cd packages_apps_Settings_<name>
git fetch https://github.com/DerpFest-OS/packages_apps_Settings.git 15
git cherry-pick <commit-hash>
```

**Popular Upstream Sources (Android 15/16):**
- `crdroidandroid/frameworks_base`, `packages_apps_SystemUI`, `packages_apps_Settings`
- `Evolution-X/frameworks_base`, `packages_apps_SystemUI`, `packages_apps_Settings`
- `DerpFest-OS/frameworks_base`, `packages_apps_SystemUI`, `packages_apps_Settings`
- `LineageOS/frameworks_base`, `packages_apps_SystemUI`, `packages_apps_Settings`

### B. Direct XML/Resource Modifications (Strings, Colors, Dimens)

No Java/Kotlin changes needed - just edit XML files:

| Target | Files to Modify |
|--------|-----------------|
| **Strings** | `res/values/strings.xml`, `res/values-<lang>/strings.xml` |
| **Colors** | `res/values/colors.xml` (statusbar, QS, notification colors) |
| **Dimensions** | `res/values/dimens.xml` (statusbar height, padding, corner radius) |
| **Config** | `res/values/config.xml` (feature flags, default styles) |
| **Layouts** | `res/layout/*.xml` (UI structure) |

---

## Feature-to-Repo Mapping

| Feature | Repo to Modify |
|---------|----------------|
| Clock style (left/center/right, format) | `frameworks_base_<name>` + `packages_apps_SystemUI_<name>` |
| Battery icon style (circle, percent, hidden) | `frameworks_base_<name>` + `packages_apps_SystemUI_<name>` |
| QS tile animation, custom tiles | `packages_apps_SystemUI_<name>` |
| Statusbar height, padding, blur | `packages_apps_SystemUI_<name>` |
| Custom Settings categories | `packages_apps_Settings_<name>` |
| Per-app volume panel | `frameworks_base_<name>` + `packages_apps_SystemUI_<name>` |
| Gesture navigation tuning | `frameworks_base_<name>` |
| Theming/Monet custom palette | `frameworks_base_<name>` |
| Lockscreen customization | `frameworks_base_<name>` + `packages_apps_SystemUI_<name>` |