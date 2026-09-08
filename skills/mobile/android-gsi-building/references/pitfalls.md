# Common Pitfalls & Solutions

| Problem | Solution |
|---------|----------|
| **Disk space exhausted** | Aggressive cleanup step (remove dotnet, android SDK, docker images, browsers). Use `df -h` to verify. |
| **`repo sync` fails** | Use `--force-sync --optimized-fetch --prune`, ensure `android_branch` exists in TrebleDroid manifest (`https://github.com/trebledroid/android_manifest/branches`). |
| **Build errors in fork** | Fork must be based on **same Android version** as manifest branch. Rebase fork to `android-15.0`. |
| **Missing dependencies** | Check `Android.bp` in fork - add `static_libs`, `shared_libs`, `defaults: ["framework-defaults"]`. |
| **SELinux denials on device** | Add rules to `device/phh/treble/sepolicy` or vendor overlay sepolicy. Check `logcat | grep avc`. |
| **`/dev/urandom` missing (git fails)** | GitHub Actions runners may lack `/dev/urandom` - use `gh api` to push files instead of `git push`. |
| **Fork not replacing upstream** | Verify `local_manifest.xml` path matches exactly (e.g., `frameworks/base`), revision matches. |
| **`make systemimage` fails** | Check `out/soong.log` for Soong errors. Usually missing deps in `Android.bp`. |
| **SystemUI/Settings not updated** | Verify fork branch name matches `android_branch` input. Check `repo sync` output for fetch errors. |
| **Bootloop after flash** | Check `adb logcat` during boot. Common: SELinux, missing init files, wrong partition size. |

## Debugging Commands

```bash
# Check what's in the built system.img
mkdir -p /tmp/system && sudo mount -o loop out/target/product/gsi_arm64/system.img /tmp/system
ls /tmp/system/framework/           # framework.jar, services.jar
ls /tmp/system/priv-app/SystemUI/   # SystemUI.apk
ls /tmp/system/priv-app/Settings/   # Settings.apk

# Verify fork changes are present
grep -r "custom_feature" /tmp/system/priv-app/SystemUI/

# Check repo sync status
cd ~/gsi && repo status
repo forall -c 'echo $REPO_PATH && git log --oneline -1'
```

## GitHub Actions Specific Issues

| Issue | Fix |
|-------|-----|
| Runner OOM / timeout | Reduce `-j$(nproc)` to `-j4` or `-j8` |
| `gh api` rate limit | Use `GITHUB_TOKEN` automatically provided |
| Artifact too large | Split upload, or use release assets instead |
| Workflow not triggering | Check `on: workflow_dispatch:` syntax, branch permissions |