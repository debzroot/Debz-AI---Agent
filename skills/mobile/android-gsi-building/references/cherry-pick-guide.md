# Cherry-Pick Guide & Upstream Sources

## Finding Commits to Cherry-Pick

### 1. Browse Upstream Repos
- crDroid: `https://github.com/crdroidandroid/frameworks_base/commits/15.0`
- Evolution X: `https://github.com/Evolution-X/frameworks_base/commits/15`
- DerpFest: `https://github.com/DerpFest-OS/frameworks_base/commits/15`
- LineageOS: `https://github.com/LineageOS/frameworks_base/commits/lineage-22.1`

### 2. Search for Feature Keywords
Search commit messages for:
- `clock` `statusbar` `battery` `qs` `quicksettings`
- `gesture` `navigation` `volume` `theme` `monet`
- `settings` `dashboard` `category` `preference`

### 3. Use GitHub Search
```
repo:crdroidandroid/frameworks_base "clock" "statusbar"
repo:Evolution-X/packages_apps_SystemUI "battery" "style"
```

## Cherry-Pick Commands

```bash
# Single commit
cd frameworks_base_<name>
git fetch https://github.com/crdroidandroid/frameworks_base.git 15.0
git cherry-pick abc1234

# Range of commits (inclusive)
git cherry-pick abc1234..def5678

# Multiple non-contiguous commits
git cherry-pick abc1234 def5678 ghi9012

# If conflicts arise
git cherry-pick --continue  # after resolving
git cherry-pick --abort     # to cancel
```

## Resolving Conflicts

Common conflict areas:
- `config.xml` - multiple ROMs modify same config flags
- `strings.xml` - string additions may overlap
- Java files - API changes between Android versions

```bash
# Check conflicted files
git status

# Edit conflicted files, then
git add <file>
git cherry-pick --continue
```

## Recommended Features by Category

### Statusbar & Clock
| Feature | Source Repo | Search Terms |
|---------|-------------|--------------|
| Clock position (L/C/R) | crDroid, Evolution X | `clock` `position` `statusbar` |
| Clock style (digital/analog) | DerpFest, LineageOS | `clock` `style` `format` |
| Battery icon styles | crDroid, Evolution X | `battery` `icon` `style` `percent` |
| Statusbar height/padding | Evolution X | `statusbar` `height` `padding` |

### Quick Settings
| Feature | Source Repo | Search Terms |
|---------|-------------|--------------|
| QS tile animations | crDroid | `qs` `tile` `animation` |
| Custom QS tiles | Evolution X | `qs` `tile` `custom` |
| QS panel layout | DerpFest | `qs` `panel` `layout` `columns` |

### Gestures & Navigation
| Feature | Source Repo | Search Terms |
|---------|-------------|--------------|
| Edge back gesture sensitivity | LineageOS | `gesture` `back` `sensitivity` |
| Three-finger screenshot | crDroid | `screenshot` `three` `finger` |
| Navbar tuner | Evolution X | `navbar` `tuner` `layout` |

### Settings
| Feature | Source Repo | Search Terms |
|---------|-------------|--------------|
| Custom Settings categories | DerpFest, Infinity-X | `dashboard` `category` `custom` |
| Per-app volume | Evolution X | `volume` `per` `app` |
| Game mode/performance | crDroid | `game` `mode` `performance` |

### Theming
| Feature | Source Repo | Search Terms |
|---------|-------------|--------------|
| Monet/Color palette | LineageOS, Evolution X | `monet` `color` `palette` `theme` |
| Icon shapes | crDroid | `icon` `shape` `round` `square` |
| Font styles | DerpFest | `font` `style` `custom` |

## Verification After Cherry-Pick

```bash
# Build check (requires full tree - do in GitHub Actions)
# Or verify locally:
grep -r "new_feature" frameworks/base/packages/SystemUI/

# Check Android.bp still valid
cat Android.bp
```