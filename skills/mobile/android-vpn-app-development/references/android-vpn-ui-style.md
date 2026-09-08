# DebNet+/DebSSH+ UI Design System (user's hacker/terminal theme)

User's preferred visual identity, extracted from their `/var/www/html/css/base.css`. Apply to the next VPN app (DebSSH+) so it matches the existing DebNet+ look — "professional, enak dilihat, gak monoton".

## Design tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--green` | `#39FF14` | PRIMARY accent: borders, cursor, buttons, online states (neon green) |
| `--red` | `#FF5F56` | Error / disconnect / macOS close-dot red |
| `--yellow` | `#FFBD2E` | Warning / middle dot |
| `--prompt` | `#0D6EFD` | Blue prompt `$` / interactive text |
| bg | `#050505` / `#060B06` | Page + parallax background (near-black w/ green tint) |
| grid | `rgba(20,80,20,.6)` 3px lines | Background grid pattern (terminal feel) |
| card | `linear-gradient(135deg, rgba(20,20,20,.5), rgba(0,0,0,.8))` + `blur(12px)` + border `rgba(57,255,20,.5)` + radius `12px` | Glassmorphism terminal card |
| font display | **Saira** | Headings, titles, buttons (bundle in app) |
| font mono | **JetBrains Mono** | Logs, code, terminal lines (bundle in app) |
| text 3D | text-shadow white-top/black-bottom + green glow | Emboss titles (`intro-text h1`) |
| dots | red/yellow/green 14px with 3D emboss shadow | Window chrome (traffic lights) in header |

## Component recipes (Compose translations)
- **Terminal card**: dark glass bg + 1px `#39FF14@50%` border + `RoundedCornerShape(12.dp)` + soft green outer glow (pulse animation `0 0 15px→30px`).
- **Buttons**: `linear-gradient(135deg, rgba(57,255,20,.12), rgba(0,0,0,.5))`, green border 1px @50%, inset highlight top-left + inset shadow bottom-right (3D emboss), small glow. Hover → brighter.
- **Command line**: dark green-tinted bg + bolt (nut) icons at left/right + 1px green border + inset glow; mono font, prompt `$` in cyan (`#00ffff`).
- **Cursor**: 8px block, `#39FF14`, `blink 1s step-end` — use for typing/connecting indicators.
- **Header chrome**: 3 dots (red/yellow/green, radial gradient, emboss) + uppercase title with 3D text-shadow.

## User layout preferences (from DebNet+ feedback)
- Version stamp (`v6.6.6`) goes ONLY inside the DEV layer at the bottom — never in the header/banner.
- "Share Logs" button lives at the bottom of the DEV screen, under the QR/traktir section.
- Banner: glitch grid + 2 animated scan lines (green & purple) + gradient title + pulsing subtitle (`🌐 STILL ANONYM 🤫`).
- Terminal log block: monospace, syntax-highlighted lines (EVT=gold, STATE=neon green, ERROR=red, CONNECTED=green, IP=cyan), `//` comment header, generous horizontal margin (24dp) so it isn't flush to card edges.
