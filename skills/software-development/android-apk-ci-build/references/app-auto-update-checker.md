# App Auto-Update Checker via GitHub API

## Pattern
Flutter app checks for newer release on GitHub at startup, shows badge in terminal header, and auto-downloads/installs APK on tap.

## Implementation (v1.3.5+)

### Dart State (HomeScreenState)
```dart
// App update checker
String? _latestVersion;
String? _latestApkUrl;
bool _checkingUpdate = false;

@override
void initState() {
  super.initState();
  // ... existing init
  _checkAppUpdate(); // Auto-check on start
}
```

### Check Logic
```dart
Future<void> _checkAppUpdate() async {
  if (_checkingUpdate) return;
  setState(() => _checkingUpdate = true);
  try {
    final response = await http.get(
      Uri.parse('https://api.github.com/repos/debzroot/debdownplus/releases/latest'),
      headers: {'Accept': 'application/vnd.github.v3+json'},
    ).timeout(const Duration(seconds: 10));
    
    if (response.statusCode == 200) {
      final data = json.decode(response.body);
      final tag = data['tag_name']?.toString().replaceFirst('v', '') ?? '';
      final assets = data['assets'] as List?;
      
      if (tag.isNotEmpty && assets != null) {
        // Find arm64 APK (preferred)
        String? apkUrl;
        for (final asset in assets) {
          final name = asset['name']?.toString() ?? '';
          if (name.contains('arm64-v8a') && name.endsWith('.apk')) {
            apkUrl = asset['browser_download_url']?.toString();
            break;
          }
        }
        // Fallback to universal APK
        apkUrl ??= assets
            .where((a) => (a['name']?.toString() ?? '').contains('DebDownPlus.apk'))
            .map((a) => a['browser_download_url']?.toString())
            .firstWhere((u) => u != null, orElse: () => null);
        
        final currentVersion = '1.3.5'; // Keep in sync with pubspec
        if (_versionCompare(tag, currentVersion) > 0 && apkUrl != null) {
          setState(() {
            _latestVersion = tag;
            _latestApkUrl = apkUrl;
          });
          _log('UPDATE AVAILABLE: v$tag (current v$currentVersion)');
        } else {
          _log('App up to date: v$currentVersion');
        }
      }
    }
  } catch (e) {
    _log('Update check failed: $e');
  } finally {
    if (mounted) setState(() => _checkingUpdate = false);
  }
}

int _versionCompare(String a, String b) {
  final pa = a.split('.').map(int.parse).toList();
  final pb = b.split('.').map(int.parse).toList();
  for (int i = 0; i < 3; i++) {
    final va = i < pa.length ? pa[i] : 0;
    final vb = i < pb.length ? pb[i] : 0;
    if (va != vb) return va.compareTo(vb);
  }
  return 0;
}
```

### Download & Install
```dart
Future<void> _downloadAndInstallUpdate() async {
  if (_latestApkUrl == null) return;
  _log('Downloading update v$_latestVersion...');
  _setStatus('[INFO] Downloading update v$_latestVersion...');
  try {
    final dir = await getExternalStorageDirectory();
    final apkFile = File('${dir!.path}/DebDownPlus_v$_latestVersion.apk');
    final response = await http.get(Uri.parse(_latestApkUrl!)).timeout(const Duration(seconds: 120));
    await apkFile.writeAsBytes(response.bodyBytes);
    _log('Update downloaded: ${apkFile.path}');
    _setStatus('[SUCCESS] Update downloaded, opening installer...');
    // Open APK installer via existing shareFile MethodChannel
    final channel = MethodChannel('debdown/ytdl');
    await channel.invokeMethod('shareFile', {
      'path': apkFile.path,
      'text': 'DebDown+ v$_latestVersion update',
    });
  } catch (e) {
    _log('Update download failed: $e');
    _setStatus('[ERROR] Update failed: $e');
  }
}
```

### Terminal Badge UI
```dart
class _TerminalConsole extends StatelessWidget {
  final List<String> statusLog;
  final AnimationController cursorCtrl;
  final String? latestVersion;
  final VoidCallback? onUpdateTap;

  @override
  Widget build(BuildContext context) {
    return GlassPanel(
      // ... existing
      Row(
        children: [
          // ... existing TERMINAL + LIVE
          if (latestVersion != null) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: onUpdateTap,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: kOrange.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: kOrange, width: 1),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.system_update_alt, color: kOrange, size: 10),
                    const SizedBox(width: 4),
                    Text('v$latestVersion', style: TextStyle(color: kOrange, fontSize: 9, fontWeight: FontWeight.bold, letterSpacing: 1)),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
      // ...
    );
  }
}
```

### Usage in Tab
```dart
_TerminalConsole(
  statusLog: _statusLog,
  cursorCtrl: _cursorCtrl,
  latestVersion: _latestVersion,
  onUpdateTap: _latestVersion != null ? _downloadAndInstallUpdate : null,
),
```

## Dependencies
- `http: ^1.2.0` (already in pubspec)
- `dart:convert` for `json.decode`

## Pitfalls
- **Rate limit**: GitHub API unauthenticated = 60 req/hr per IP. CI runners share IPs → intermittent 403. Cache or add `if-modified-since` header, or accept occasional failures (logged, non-blocking).
- **Version sync**: `currentVersion` hardcoded in Dart must match `pubspec.yaml` `version:`. Automate via build script or manual discipline.
- **APK selection**: Always prefer arm64-v8a (modern devices). Fallback to universal `DebDownPlus.apk`. x86_64/armeabi-v7a only for specific arch.
- **Install flow**: Downloaded APK opened via `shareFile` MethodChannel → Android's "Install unknown apps" prompt → user confirms. Works without root.
- **Permission**: `getExternalStorageDirectory()` requires storage permission (already granted for downloader).

## UI/UX Notes
- Badge appears inline in terminal header (right of "LIVE") — non-intrusive.
- Orange color (#FF8C00) matches "TRAKTIR KOPI" CTA.
- Tap to download → terminal shows progress → installer opens.
- User never leaves app; seamless update experience.