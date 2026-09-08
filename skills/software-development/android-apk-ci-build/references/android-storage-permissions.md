# Android storage permissions: scoped storage + writable-dir fallback chain (verified 2026-08, DebDown+ v1.3.3)

The recurring failure: a downloader app writes to the public Download dir and the engine dies with
`ERROR: Unable to create directory: [Errno 13] Permission denied: '/storage/emulated/0/Download/<App>'`.
User-side cause: **All Files Access (MANAGE_EXTERNAL_STORAGE) not granted** — not a code bug.

## Android storage permission reality (the model to keep in your head)
- **Android 10+ (API 29+)**: scoped storage — apps write freely only inside their own dirs; the public
  `Download/` is accessible via MediaStore / the Downloads provider, not raw file paths.
- **Android 11+ (API 30+)**: writing to public Download via raw path needs
  `MANAGE_EXTERNAL_STORAGE` ("All files access") — a Settings toggle, NOT a runtime dialog.
- **OEM skins (Realme/ColorOS, MIUI, EMUI…) are stricter than AOSP**: the storage runtime permission
  dialog alone is often insufficient. User must go to Settings → Apps → <App> → Special app access →
  "All files access" → Allow. When a user reports Permission denied on a Chinese-OEM device, lead with
  this instruction before touching code.
- `WRITE_EXTERNAL_STORAGE` runtime permission is legacy (API ≤ 28); on 29+ it's ignored.

## The trap: mkdirs() silently succeeds without permission
`Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)` returns a path even when the app
can't write there, and `File.mkdirs()` returns true (or the dir already exists). Only an actual file
write throws. **Never trust existence or mkdirs — verify with a probe write:**

```kotlin
val writable = try {
    if (!base.exists()) base.mkdirs()
    val probe = File(path, ".probe")
    probe.createNewFile()   // this is the real test
    probe.delete()
    true
} catch (e: Exception) {
    false
}
```

## v1.3.3 decision: NO fallback — force public Download dir only
User explicitly: "hasil download udah biarin aja ke folder /Download/DebDown+ jangan ke path aplikasi ribet ga bakal ketemu sama file manager biasa."

The app now **only attempts** `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)/DebDown+`. If permission is denied, the write fails in the engine (yt-dlp) and the error propagates to UI — this is the intended behavior so the user knows to enable All Files Access.

Previous fallback chain (REMOVED in v1.3.3):
- App-specific external: `getExternalFilesDir(DIRECTORY_DOWNLOADS)/DebDown+` — always writable, hidden on Android 11+, wiped on uninstall
- Last resort: `cacheDir/DebDown+`

Removed: probe-write verification, `{type:'dir', fallback, path}` EventChannel event, and Dart handler for `dir` events. The app no longer silently redirects downloads.

## Permission-status logging at startup (helps remote debugging)
In `_requestPermissions()` check in order and log each result so the user's shared SYSTEM LOGS show the
real state: `Permission.storage` → `Permission.manageExternalStorage` (permission_handler).
Log lines (updated v1.3.3):
- `Storage: All Files Access GRANTED — Download/ terbuka`
- `Storage: partial (media only) — Download/ butuh All Files Access`
- `Storage: NOT granted — Download/ mungkin gagal (aktifkan All Files Access di Settings)`

The log is the fastest way to diagnose a remote device's permission state from a pasted SYSTEM LOGS.txt.

## Escape hatch: share the file out of the app dir (UNCHANGED)
Since the user can't browse `Android/data/`, the completion overlay should offer SHARE via
FileProvider + `ACTION_SEND` (own MethodChannel handler `shareFile(path, text)`) — another app with
All Files Access (Files by Google, etc.) can then save it into `Download/`.
