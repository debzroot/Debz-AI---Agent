# User UI Preferences & Iteration History (DebDown+ project)

Debz (Indonesian user) has a specific hacker/terminal aesthetic and interaction preferences. Every Flutter iteration must match these — deviation triggers immediate correction.

## Core Aesthetic
- **Background**: `#050505` (near-black)
- **Primary neon**: `#39FF14` (bright green)
- **Accents**: `#AF82FF` (purple), `#FF8C00` (orange), `#00FFFF` (cyan), `#FF003C` (red)
- **Banner bg**: `#121826` (dark blue-gray)
- **Icon bg**: `#071207` (dark green-black)
- **Glass panels**: backdrop blur + green glow border (`#39FF14` at 15-25% opacity)
- **Font**: Saira variable (google/fonts) — weights registered per weight in pubspec pointing to same TTF

## Component Specs (as corrected across sessions)

### GlitchBanner (header, ported from Compose New_file.txt)
```dart
Container(
  height: 150,
  decoration: BoxDecoration(
    color: Color(0xFF121826),           // solid, not transparent
    borderRadius: BorderRadius.circular(16),
    border: Border.all(color: kCyan.withOpacity(0.5)),
    boxShadow: [BoxShadow(color: kCyan.withOpacity(0.15), blurRadius: 24)],
  ),
  child: ClipRRect(
    borderRadius: BorderRadius.circular(15),
    child: AnimatedBuilder(
      animation: _ctrl, // 3s repeat
      builder: (_, __) {
        final t = _ctrl.value;
        // TWO scanlines with sin motion:
        final y1 = 20 + (150 - 40) * (0.5 + 0.5 * sin(t * 2 * pi)); // green, 2.5px
        final y2 = 20 + (150 - 40) * (0.5 + 0.5 * sin(t * 3 * pi + 1.5)); // purple, 2px
        // Subtitle pulse:
        final pulse = (0.7 + 0.3 * sin(t * 4 * pi)).clamp(0.0, 1.0);
        return Stack(children: [
          Positioned.fill(child: CustomPaint(painter: _GlitchBannerPainter(y1, y2))),
          Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            ShaderMask( // title: "// ⚡ DebDown+"
              shaderCallback: (b) => LinearGradient(colors: [kGreen, kCyan, kPurple]).createShader(b),
              child: Text('// ⚡ DebDown+', style: TextStyle(fontFamily: kMono, fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: 4, color: Colors.white)),
            ),
            SizedBox(height: 8),
            Opacity(opacity: pulse, child: Text('🚀 Video / Audio Downloader 🔥', style: TextStyle(fontFamily: kMono, fontSize: 12.5, fontWeight: FontWeight.w600, letterSpacing: 1.5, color: kOrange))),
          ])),
        ]);
      },
    ),
  ),
)
```
- Grid: cyan 8% opacity, lines every 30px
- Title: monospace, gradient green→cyan→purple, w900, letterSpacing 4
- Subtitle: orange, pulsing opacity

### Terminal Console (fixed height 150px, syntax highlight)
```dart
Container(
  height: 150,
  width: double.infinity,
  padding: EdgeInsets.all(8),
  decoration: BoxDecoration(color: Colors.black.withOpacity(0.55), borderRadius: BorderRadius.circular(8), border: Border.all(color: Colors.grey.shade800)),
  child: ListView.builder(reverse: true, itemCount: statusLog.length, itemBuilder: ...)
)
```
**Syntax highlight (helper `_highlightTerminal`):**
| Pattern | Color | Bold |
|---------|-------|------|
| Timestamp `[yyyy-mm-dd hh:mm:ss]` | Grey 600 | No |
| `[ERROR]` / `[NETWORK ERROR]` / `[FAILED]` / `[MISMATCH]` | Red | Yes |
| `[SUCCESS]` / `[OK]` | Green | Yes |
| `[INFO]` / `[ABORTED]` / `[WARNING]` / `[WARN]` / `[ENGINE]` | Yellow | No |
| `NN%` / `NN.N%` | Yellow | No |
| `https?://...` | Cyan | No |
| `⚡DebDown+...` | Cyan | No |
| Default text | Green | No |

### Completion Overlay (SOLID, no auto-hide)
- Barrier: solid `#050505` full-screen (NOT transparent/glass)
- Card: `#0D160D` rounded 16dp, green border 1.5px, green glow
- Animation: elastic pop-in ~900ms
- Content: success message + saved path + **CLOSE button only**
- NO auto-hide timer, NO particle burst, NO green flash

### Dev Tab (v1.3.4+ — vertically centered, left-aligned)
```dart
LayoutBuilder(builder: (context, constraints) {
  return SingleChildScrollView(
    padding: EdgeInsets.fromLTRB(12, 4, 12, 8),
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: constraints.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [ ... ]
        ),
      ),
    ),
  );
})
```
- Profile image: 90×90 (was 120)
- QR DANA: 150×150 (was 190)
- SYSTEM LOGS terminal: 120px height (was 150)
- All spacing compressed: 30→12, 24→12, 28→14, etc.

### Supported Platform Grid (below terminal, fills dead space)
2 rows × 3 chips, glass style with brand colors + glow:
| Platform | Color | Icon |
|----------|-------|------|
| YouTube | `#FF0033` | play_circle_fill |
| TikTok | `#25F4EE` | music_note |
| Instagram | `#E1306C` | camera_alt |
| X/Twitter | White | close |
| Facebook | `#1877F2` | facebook |
| SoundCloud | `#FF5500` | graphic_eq |
Footer: `+ 1000 situs lainnya 🚀`

### Downloader Tab Layout (compact, single screen)
```dart
SingleChildScrollView(
  padding: EdgeInsets.fromLTRB(12, 4, 12, 8),
  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    GlitchBanner(),                    // header
    SizedBox(8),
    GlassButton('CARA PAKAI', kCyan),
    SizedBox(8),
    GlassField(urlController, 'Paste Link...'),
    SizedBox(6),
    Row([FormatChip('MP4'), FormatChip('MP3')]),
    SizedBox(8),
    GlassButton('START DOWNLOAD' / 'DOWNLOADING...', kGreen),
    if (downloading) [SizedBox(6), GlassButton('CANCEL', kRed)],
    SizedBox(8),
    if (downloading) [HackerDownloadPanel(...), SizedBox(8)],
    TerminalConsole(...),
    SizedBox(8),
    PlatformGrid(),
    SizedBox(4),
  ]),
)
```
- NO AppBar (removed in v1.3.3)
- GlitchBanner IS the header
- All gaps 4-8px (was 12-20px)

## Branding Rules (hard constraints)
- **Never show "yt-dlp" / "youtubedl" / "vyt-dlp" / "YT-DLP" in user-visible UI**
  - Engine status: `ENGINE DONE` (not `ENGINE v2026.xx`)
  - Init log: `Engine initialized: DONE` (not `vnull` / version)
  - Update log: `Engine update: DONE` (not `DONE|version`)
  - Download status: `⚡DebDown+ downloading...` (brand, not engine)
- **Log headers**: `DEBDOWN+ vX.Y.Z - SYSTEM LOGS`
- **Startup log**: `App started vX.Y.Z`
- **Terminal ready**: `SYSTEM READY [vX.Y.Z]`

## Interaction Preferences
- "jgn dulu build ke github / tunggu instruksi dari saya" — NO build push until explicit
- After successful build: **link only**, never download APK locally
- Communicate in Indonesian (casual mixed tone OK)
- "compact jadi semua element tuh ada tanpa harus scroll kebawah" — single-screen density
- "rating kiri atas kanan bawah sama rata" — centered Dev tab
- "bersihkan log engine" — clean DONE-only logs

## Version Bump Discipline (v1.3.4+)
Single commit bumps:
1. `pubspec.yaml` → `version: X.Y.Z+1`
2. `lib/main.dart` → 4 occurrences: `SYSTEM READY [vX.Y.Z]`, `App started vX.Y.Z`, `DEBDOWN+ vX.Y.Z - SYSTEM LOGS`, `_engineStatus` init
3. Git commit → push → CI auto-releases with correct tag

---

## Iteration History (for reference)

| Version | Key Changes |
|---------|-------------|
| v1.0.0 | youtube_explode_dart engine, basic UI |
| v1.1.0 | share_plus removed (kotlin-stdlib conflict), native share MethodChannel |
| v1.2.0 | Engine swap: youtubedl-android (native yt-dlp), MP4 muxed audio, MP3, auto-update |
| v1.3.0 | Adaptive icons + monochrome (Android 13 themed), icon generator script |
| v1.3.1 | GlitchBanner header (Compose port), DownloadCompleteOverlay solid + CLOSE |
| v1.3.2 | Platform grid + footer, compact spacing, Dev tab renamed/colored |
| v1.3.3 | Proper APK signing (r0adkll/sign-android-release), storage forced to Download/, no fallback |
| v1.3.4 | Clean engine logs (DONE only), Dev tab vertically centered, bracket fixes |