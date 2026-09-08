# Device-Specific Considerations

## Infinix Smart 10 Plus (Unisoc T7250)

| Spec | Value |
|------|-------|
| **SoC** | Unisoc T7250 (Octa-core, ARM64) |
| **Architecture** | ARM64 (binder64) |
| **GSI Target** | `treble_arm64_bvN` (GApps) / `treble_arm64_bgN` (Vanilla) |
| **RAM/Storage** | 8GB / 128GB - well within GSI limits |

## Add Device Overlay via Local Manifest

Add to workflow or create static `local_manifests/device.xml`:

```xml
<project name="<user>/device_overlay_<name>"
         path="vendor/<name>/overlays"
         remote="github"
         revision="main" />
```

## Common Device Fixes

| Issue | Fix Location |
|-------|--------------|
| SELinux denials | `device/phh/treble/sepolicy` or vendor overlay sepolicy |
| Init/hwconfig | `vendor/<name>/overlays/init/` |
| Props/overrides | `vendor/<name>/overlays/proprietary/` |

## Unisoc (Spreadtrum) Specifics

- TrebleDroid includes Unisoc support out of the box
- May need additional props in `vendor/<name>/overlays/proprietary/`:
  - `ro.vendor.unisoc.*` properties
  - `ro.hardware=unisoc`
- Check `device/phh/treble/unisoc/` for existing configs

## Testing on Device

### Quick Test: DSU (No Flash)
```bash
adb shell dsu load system.img
# Reboots into GSI temporarily
```

### Permanent Flash
```bash
# Via fastbootd (recommended)
fastboot flash system system.img
fastboot reboot

# Via TWRP
# Copy system.img → TWRP → Install → Install Image → system.img → System partition
```