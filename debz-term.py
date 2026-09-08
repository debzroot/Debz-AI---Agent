import re
import sys
import os
import time
import json
import argparse
import textwrap
import threading
import subprocess
import difflib
import select
import shutil
import glob
from itertools import cycle

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DEBUG_LOG_PATH = os.path.join(PROJECT_ROOT, "debug.log")
sys.path = [p for p in sys.path if p]

try:
    import requests
    from rich.console import Console, Group
    from rich.panel import Panel
    from rich.text import Text
    from rich.table import Table
    from rich.markdown import Markdown
    from rich.live import Live
    from rich.theme import Theme
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion, PathCompleter
    from prompt_toolkit.styles import Style
    from prompt_toolkit.formatted_text import HTML
    from prompt_toolkit.shortcuts import CompleteStyle
    from rich.spinner import Spinner
    from prompt_toolkit.formatted_text import FormattedText
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests", "rich", "prompt_toolkit"], check=False)
    import requests
    from rich.console import Console, Group
    from rich.panel import Panel
    from rich.text import Text
    from rich.table import Table
    from rich.markdown import Markdown
    from rich.live import Live
    from rich.theme import Theme
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion, PathCompleter
    from prompt_toolkit.styles import Style
    from prompt_toolkit.formatted_text import HTML
    from prompt_toolkit.shortcuts import CompleteStyle
    from rich.spinner import Spinner
    from prompt_toolkit.formatted_text import FormattedText

THEME = {
    "bg": "#141613",
    "surface": "#1b1e19",
    "surface_alt": "#20241e",
    "text": "#a7ad98",
    "muted": "#676d60",
    "green": "#758b68",
    "green_soft": "#64775a",
    "cyan": "#6f8985",
    "yellow": "#9a895f",
    "red": "#906866",
    "magenta": "#84718a",
    "border": "#454b40",
    "border_focus": "#66715e",
    "root_bg": "#221c29",
    "ai_bg": "#24201a",
}

retro_theme = Theme({
    "green": THEME["green"],
    "red": THEME["red"],
    "cyan": THEME["cyan"],
    "yellow": THEME["yellow"],
    "magenta": THEME["magenta"],
    "white": THEME["text"],
    "black": THEME["bg"],
})

console = Console(color_system="truecolor", highlight=False, soft_wrap=False, theme=retro_theme)

BRAND_NAME = "Debz AI"
VERSION    = "3.6.1-PRO-STABLE"
COOLDOWN   = int(os.environ.get("DEBZ_COOLDOWN", "300"))
MAX_RETRY  = 3

ASCII_BANNER = r"""
 ██████╗ ███████╗██████╗ ███████╗    █████╗ ██╗
 ██╔══██╗██╔════╝██╔══██╗╚══███╔╝   ██╔══██╗██║
 ██║  ██║█████╗  ██████╔╝  ███╔╝    ███████║██║
 ██║  ██║██╔══╝  ██╔══██╗ ███╔╝     ██╔══██║██║
 ██████╔╝███████╗██████╔╝███████╗   ██║  ██║██║
 ╚═════╝ ╚══════╝╚═════╝ ╚══════╝   ╚═╝  ╚═╝╚═╝
"""

TOOL_ICONS_MAP = {
    "shell": "⚡", "read_file": "📖", "write_file": "✍️", "list_dir": "🔎", "search": "🔎",
    "http_request": "🌐", "download_file": "⬇️", "db_query": "🗄️", "archive": "🗜️",
    "process_list": "📊", "process_kill": "💀", "note": "🧠", "skill": "📚", "app_install": "📦",
}

def _get_dynamic_label(name, args):
    if name == "read_file": return f"Read: {os.path.basename(args.get('path', '')) or args.get('path', '')}"
    elif name == "write_file": return f"Edit: {os.path.basename(args.get('path', '')) or args.get('path', '')}"
    elif name == "shell": return f"Shell: {args.get('command', '')[:30]}..." if len(args.get('command', '')) > 30 else f"Shell: {args.get('command', '')}"
    elif name == "search": return f"Search: {args.get('pattern', '')[:15]}"
    elif name == "list_dir": return f"List: {os.path.basename(args.get('path', '')) or args.get('path', '') or '/'}"
    elif name == "http_request": return f"HTTP: {args.get('url', '')[:30]}..." if len(args.get('url', '')) > 30 else f"HTTP: {args.get('url', '')}"
    elif name == "download_file": return f"DL: {os.path.basename(args.get('path', 'file'))}"
    elif name == "db_query": return f"DB: {args.get('sql', '')[:20]}"
    elif name == "archive": return f"Archive: {args.get('action', '')}"
    elif name == "process_list": return f"PS: {args.get('pattern', 'all')}"
    elif name == "process_kill": return f"Kill: {args.get('pid', args.get('pattern', '?'))}"
    elif name == "skill": return f"Skill: {args.get('action', '')}"
    elif name == "note": return f"Note: {args.get('action', '')}"
    elif name == "app_install": return f"Pkg: {args.get('action', '')}"
    return name

def _providers_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ai-providers.json")

def _read_providers():
    try:
        with open(_providers_path(), "r", encoding="utf-8") as f: d = json.load(f)
        p = d.get("providers", {})
        a = d.get("active", "")
        if not a or a not in p: a = next(iter(p), "") if p else ""
        return a, p
    except Exception:
        return "", {}

def _provider_cfg(p, cfg):
    b = (p.get("base_url") or "").rstrip("/") or cfg.get("ENDPOINT", "")
    for s in ("/chat/completions", "/completions"):
        if b.endswith(s): b = b[:-len(s)]; break
    return {
        "endpoint": b.rstrip("/") + "/chat/completions",
        "key": p.get("api_key", ""),
        "model": p.get("model", ""),
        "extra": p.get("extra", {}),
        "name": p.get("name", p.get("id", "?")),
    }

def _set_active_provider(prov_id, model=None):
    path = _providers_path()
    try:
        with open(path, "r", encoding="utf-8") as f: d = json.load(f)
        if prov_id not in (d.get("providers") or {}): return False
        d["active"] = prov_id
        if model: d["providers"][prov_id]["model"] = model
        backup_path = path + ".bak"
        try: shutil.copy2(path, backup_path)
        except Exception: pass
        with open(path + ".tmp", "w", encoding="utf-8") as f: json.dump(d, f, indent=2, ensure_ascii=False)
        os.replace(path + ".tmp", path)
        return True
    except Exception: return False

def _load_config():
    cfg = {"API_KEY": "", "ENDPOINT": "https://api.tokenrouter.com/v1/chat/completions", "MODEL": "z-ai/glm-5.3-free", "TOOLS_TOKEN": "", "TOOLS_PORT": 999, "MAX_ITER": 40, "MAX_TOKEN": 128000, "_CLI_MODEL": ""}
    ini = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ai-config.ini")
    if os.path.exists(ini):
        try:
            for line in open(ini, "r", encoding="utf-8", errors="replace"):
                line = line.strip()
                if not line or line.startswith(";") or line.startswith("#"): continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    kk = k.strip()
                    kk = kk[3:] if kk.startswith("AI_") else kk
                    if kk in cfg and v.strip():
                        cfg[kk] = int(v) if kk in ("MAX_ITER", "MAX_TOKEN", "MAX_OUTPUT_TOKENS", "TOOLS_PORT") else v.strip()
        except Exception: pass
    a_id, provs = _read_providers()
    if a_id and a_id in provs:
        pc = _provider_cfg(provs[a_id], cfg)
        cfg["ENDPOINT"] = pc["endpoint"]
        if pc["key"]: cfg["API_KEY"] = pc["key"]
        if pc["model"]: cfg["MODEL"] = pc["model"]
        if pc["extra"]: cfg["EXTRA"] = pc["extra"]
    cfg["_PROV_ID"], cfg["_PROVIDERS"] = a_id, provs
    cfg["_ROUTING"] = _read_routing()
    return cfg

def refresh_cfg(cfg):
    a_id, provs = _read_providers()
    if not provs: return cfg
    if not a_id or a_id not in provs: a_id = cfg.get("_PROV_ID", "") or next(iter(provs))
    if a_id and a_id in provs:
        pc = _provider_cfg(provs[a_id], cfg)
        cfg["ENDPOINT"] = pc["endpoint"]
        if pc["key"]: cfg["API_KEY"] = pc["key"]
        cfg["EXTRA"] = pc["extra"] or {}
        if pc["model"] and not cfg.get("_CLI_MODEL"): cfg["MODEL"] = pc["model"]
    cfg["_PROV_ID"], cfg["_PROVIDERS"] = a_id, provs
    cfg["_ROUTING"] = _read_routing()
    return cfg

UA_OK_HARNESS = "opencode/1.0 (linux; x64)"
def _sanitize_ua(ua):
    return UA_OK_HARNESS if not ua or "compat" in ua.lower() or not re.match(r"^[A-Za-z0-9._-]+/\d", ua) else ua

TRANSPORT_KEYS = {"user_agent", "referer", "x_title", "headers"}

def _rr_state_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ai-rr-state.json")

def _routing_of(data):
    r = str(data.get("routing", "fixed") or "fixed").lower()
    return r if r in ("fixed", "roundrobin", "failover") else "fixed"

def _read_routing():
    try:
        with open(_providers_path(), "r", encoding="utf-8") as f:
            return _routing_of(json.load(f))
    except Exception:
        return "fixed"

def _enabled_ids(provs):
    return [pid for pid, p in (provs or {}).items() if (p.get("enabled", True) is not False)]

def _apply_provider(cfg, pid, mark_active=True):
    provs = cfg.get("_PROVIDERS") or {}
    p = provs.get(pid)
    if not p: return False
    pc = _provider_cfg(p, cfg)
    if not pc["key"]: pc["key"] = cfg.get("API_KEY", "")
    cfg["ENDPOINT"] = pc["endpoint"]
    cfg["API_KEY"] = pc["key"]
    if pc["model"]: cfg["MODEL"] = pc["model"]
    cfg["EXTRA"] = pc["extra"] or {}
    cfg["_PROV_ID"] = pid
    if mark_active:
        _set_active_provider(pid)
    return True

def _rotate_for_rr(cfg, announce=True):
    if cfg.get("_ROUTING") != "roundrobin":
        return
    provs = cfg.get("_PROVIDERS") or {}
    pool = _enabled_ids(provs)
    if not pool:
        return
    st = {}
    try:
        with open(_rr_state_path(), "r", encoding="utf-8") as f:
            st = json.load(f) or {}
    except Exception:
        st = {}
    try:
        idx = int(st.get("idx", 0) or 0) % len(pool)
    except Exception:
        idx = 0
    st["idx"] = idx + 1
    try:
        with open(_rr_state_path(), "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass
    pid = pool[idx]
    if _apply_provider(cfg, pid, mark_active=False):
        if announce:
            console.print(f"  [dim cyan]🔀 round-robin → {pid}[/dim cyan]")

def _set_routing(mode):
    path = _providers_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        d["routing"] = mode
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2, ensure_ascii=False)
        os.replace(path + ".tmp", path)
        return True
    except Exception:
        return False

def _gen_session_id(base_url, api_key="", ua=""):
    import uuid as _uuid
    base = (base_url or "").strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        return None, "base_url invalid", ""
    headers = {"Authorization": "Bearer " + api_key, "Accept": "application/json"}
    if not ua and "openrouter.ai" in base:
        ua = UA_OK_HARNESS
    if ua:
        headers["User-Agent"] = ua
    try:
        r = requests.get(base + "/models", headers=headers, timeout=12)
        if r.ok:
            sid = r.headers.get("x-session-id") or r.headers.get("X-Session-Id")
            if sid: return sid.strip(), "-", "response"
    except Exception: pass
    try:
        body = {"model": "test", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}
        r = requests.post(base + "/chat/completions", headers={**headers, "Content-Type": "application/json"}, json=body, timeout=12)
        if r.ok:
            sid = r.headers.get("x-session-id") or r.headers.get("X-Session-Id")
            if sid: return sid.strip(), "-", "response"
    except Exception: pass
    return str(_uuid.uuid4()), "-", "generated"

def _set_provider_sid(prov_id, sid):
    path = _providers_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        if prov_id not in (d.get("providers") or {}):
            return False
        extra = d["providers"][prov_id].setdefault("extra", {})
        if not isinstance(extra.get("headers"), dict):
            extra["headers"] = {}
        if sid is None:
            extra["headers"].pop("x-session-id", None)
            if not extra["headers"]:
                extra.pop("headers", None)
        else:
            extra["headers"]["x-session-id"] = sid
        backup_path = path + ".bak"
        try: shutil.copy2(path, backup_path)
        except Exception: pass
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2, ensure_ascii=False)
        os.replace(path + ".tmp", path)
        return True
    except Exception:
        return False

def _get_headers(cfg):
    h = {"Authorization": f"Bearer {cfg['API_KEY']}", "Content-Type": "application/json"}
    e = cfg.get("EXTRA", {})
    h["User-Agent"] = _sanitize_ua(e.get("user_agent") or UA_OK_HARNESS)
    if "referer" in e: h["HTTP-Referer"] = e["referer"]
    elif "openrouter.ai" in cfg.get("ENDPOINT", ""): h["HTTP-Referer"] = "https://c0n73xt.app"
    if "x_title" in e: h["X-Title"] = e["x_title"]
    elif "openrouter.ai" in cfg.get("ENDPOINT", ""): h["X-Title"] = "c0n73xt WebUX"
    for hk, hv in (e.get("headers") or {}).items():
        if hv is None or str(hv) == "": continue
        h[str(hk)] = str(hv)
    return h

class OverloadedError(Exception): pass
class PermanentError(Exception): pass
class HoldSignal(Exception): pass

def log_debug(msg):
    try:
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} | {msg}\n")
    except Exception: pass

def fmt_k(n):
    return f"{n/1000.0:.1f}".rstrip("0").rstrip(".") + "k" if n >= 1000 else str(n)

def check_tools_server(cfg):
    try:
        r = requests.get(f"http://127.0.0.1:{cfg['TOOLS_PORT']}/api/health", timeout=2)
        return r.status_code == 200
    except Exception:
        try:
            r = requests.post(f"http://127.0.0.1:{cfg['TOOLS_PORT']}/", headers={"Content-Type":"application/json"}, json={}, timeout=2)
            return r.status_code in (200, 404)
        except Exception: return False

def _ask_permission(reason, command):
    options = [
        ("once",    "Izinkan SEKALI ini saja"),
        ("session", "Izinkan SESI ini (sampai /reset)"),
        ("always",  "Izinkan SELALU (auto-approve)"),
        ("deny",    "TOLAK perintah ini"),
    ]
    if sys.stdout.isatty():
        try:
            from prompt_toolkit.application import Application
            from prompt_toolkit.key_binding import KeyBindings
            from prompt_toolkit.layout import Layout, Window
            from prompt_toolkit.layout.controls import FormattedTextControl
            from prompt_toolkit.shortcuts.dialogs import Dialog, Box
            from prompt_toolkit.formatted_text import HTML
            from prompt_toolkit.styles import Style as _Style
            from prompt_toolkit.application.current import create_app_session
            import asyncio

            try:
                asyncio.set_event_loop(asyncio.new_event_loop())
            except Exception:
                pass

            def _clean(s):
                return str(s or "").replace("\n", " ").replace("\r", " ").strip()

            reason_t = _clean(reason)
            cmd_t = "$ " + _clean(command)
            if len(reason_t) > 80: reason_t = reason_t[:79] + "…"
            if len(cmd_t) > 80: cmd_t = cmd_t[:79] + "…"

            idx = 0

            def _content():
                lines = []
                lines.append(("class:preason", reason_t + "\n"))
                lines.append(("class:pcmd", cmd_t + "\n"))
                lines.append(("", "\n"))
                for i, (val, label) in enumerate(options):
                    mark = "●" if i == idx else "○"
                    cls = "class:pselected" if i == idx else "class:plabel"
                    lines.append((cls, "  " + mark + " " + label + "\n"))
                lines.append(("", "\n"))
                lines.append(("class:phint", "  ↑↓ pilih · Enter = OK · Esc = TOLAK"))
                return lines

            kb = KeyBindings()

            @kb.add("down")
            def _down(event):
                nonlocal idx
                idx = (idx + 1) % len(options)
                event.app.invalidate()

            @kb.add("up")
            def _up(event):
                nonlocal idx
                idx = (idx - 1) % len(options)
                event.app.invalidate()

            @kb.add("enter")
            def _ok(event):
                event.app.exit(result=options[idx][0])

            @kb.add("escape")
            def _esc(event):
                event.app.exit(result=None)

            control = FormattedTextControl(_content, focusable=True)
            dialog = Dialog(
                title=HTML("<ansiyellow>⚠️  PERMISSION</ansiyellow>"),
                body=Box(Window(content=control, wrap_lines=True), padding=1),
                with_background=True,
            )
            st = _Style.from_dict({
                "dialog": "bg:#1b1e19 #a7ad98",
                "dialog.title": "bold #9a895f",
                "dialog.body": "bg:#1b1e19 #a7ad98",
                "dialog shadow": "bg:#000000",
                "preason": "#a7ad98",
                "pcmd": "#676d60",
                "plabel": "#a7ad98",
                "pselected": "bold #141613 bg:#758b68",
                "phint": "#676d60",
            })
            
            with create_app_session():
                app = Application(layout=Layout(dialog), key_bindings=kb, style=st, full_screen=True)
                result = app.run()
            return result if result is not None else "deny"
        except Exception as e:
            log_debug(f"permission dialog error, fallback: {e}")
            
    answer = console.input(f"[{THEME['yellow']}]  Izinkan? [y]once · [s]ession · [a]allow · [N]tolak [/{THEME['yellow']}]").strip().lower()
    if answer in ("y", "yes"): return "once"
    if answer in ("s", "session"): return "session"
    if answer in ("a", "all", "always"): return "always"
    return "deny"

class UI:
    def banner(self, cfg, tools_on):
        banner = Text(ASCII_BANNER, style=THEME["green_soft"])
        console.print(banner)
        console.print(Text("  " + "-" * 36, style=THEME["border"]))
        console.print(Text(f"  c0n73xt / v{VERSION}", style=THEME["muted"]))
        if cfg.get("_PROV_ID"):
            line = Text("  provider  ", style=THEME["cyan"])
            line.append(str(cfg.get("_PROV_ID")), style=THEME["magenta"])
            console.print(line)
        line = Text("  model     ", style=THEME["cyan"])
        line.append(str(cfg["MODEL"]), style=THEME["text"])
        console.print(line)
        line = Text("  routing   ", style=THEME["cyan"])
        line.append(str(cfg.get("_ROUTING", "fixed")), style=THEME["text"])
        console.print(line)
        line = Text("  tools     ", style=THEME["cyan"])
        line.append("ON" if tools_on else "OFF", style=THEME["green"] if tools_on else THEME["red"])
        console.print(line)
        console.print(Text("  " + "-" * 36, style=THEME["border"]))

    def user_box(self, text):
        console.print()
        panel_content = Text(text.strip() or "(empty)", style=THEME["text"])
        panel = Panel(
            panel_content,
            title=Text(" ROOT 👾 ", style=THEME["cyan"]),
            title_align="left",
            border_style=THEME["border_focus"],
            padding=(1, 2),
        )
        panel.style = f"on {THEME['root_bg']}"
        console.print(panel)

    def ai_box(self, text):
        console.print()
        content = Markdown(
            text.strip() or "(empty)",
            style=THEME["text"],
            code_theme="ansi_dark",
        )
        panel = Panel(
            content,
            title=Text(" DEBZ AI 👻 ", style=THEME["green"]),
            title_align="left",
            border_style=THEME["border"],
            padding=(1, 2),
        )
        panel.style = f"on {THEME['ai_bg']}"
        console.print(panel)
        console.print()

    def memory_bar(self, used, mx, pct):
        width = 12
        filled = int(round(width * pct / 100))
        color = THEME["red"] if pct >= 95 else THEME["yellow"] if pct >= 80 else THEME["green_soft"]
        line = Text("  mem  ", style=THEME["cyan"])
        line.append("[", style=THEME["border"])
        line.append("━" * filled, style=color)
        line.append("-" * (width - filled), style=THEME["border"])
        line.append("]", style=THEME["border"])
        line.append(f" {int(pct):3d}% ", style=color)
        line.append(f"{fmt_k(used)}/{fmt_k(mx)}", style=THEME["muted"])
        console.print(line)

class WorkTree:
    MAX_ROWS = 5
    SPINNER_FRAMES = ("◐", "◓", "◑", "◒")

    def __init__(self, tty):
        self.tty = tty
        self.cur = None
        self.rows = []
        self.frozen = False
        self.live = None
        self.spinner_index = 0
        self.lock = threading.RLock()
        self._start_live()
        self.closed = False
        self.ticker = threading.Thread(target=self._tick_loop, daemon=True)
        self.ticker.start()
        
    def _tick_loop(self):
        while not self.closed:
            time.sleep(0.09)
            try:
                if self.cur and not self.frozen:
                    self._refresh()
            except Exception:
                pass
   
    def _start_live(self):
        with self.lock:
            if not self.tty or self.live is not None:
                return
            self.live = Live(
                self._renderable(),
                console=console,
                refresh_per_second=12,
                transient=True,
                auto_refresh=True,
                vertical_overflow="crop",
            )
            self.live.start(refresh=True)

    def _stop_live(self):
        with self.lock:
            if self.live is not None:
                self.live.stop()
                self.live = None

    def _row(self, icon, label, state="running", elapsed=None):
        text = Text(no_wrap=True, overflow="ellipsis")
        text.append("  ")

        if state == "running":
            marker = self.SPINNER_FRAMES[self.spinner_index % len(self.SPINNER_FRAMES)]
            self.spinner_index += 1
            text.append(marker + " ", style=THEME["cyan"])
        elif state == "waiting":
            text.append("Ⅱ ", style=THEME["yellow"])
        elif state == "done":
            text.append("✓ ", style=THEME["green_soft"])
        else:
            text.append("× ", style=THEME["red"])

        text.append(str(icon) + " ", style=THEME["muted"])
        text.append(
            str(label),
            style=THEME["cyan"] if state == "running" else THEME["yellow"] if state == "waiting" else THEME["text"]
        )

        if state == "running": text.append(" ...", style=THEME["muted"])
        elif state == "waiting": text.append("  paused", style=THEME["yellow"])
        elif elapsed is not None: text.append(f"  {elapsed}s", style=THEME["muted"])
        return text

    def _renderable(self):
        with self.lock:
            rows = list(self.rows[-self.MAX_ROWS:])
            while len(rows) < self.MAX_ROWS:
                rows.insert(0, Text(""))
            return Group(*rows)

    def _refresh(self):
        with self.lock:
            if self.frozen: return
            if self.live is None: self._start_live()
            if self.live:
                if self.cur and self.rows:
                    self.rows[-1] = self._row(self.cur["icon"], self.cur["label"], "running")
                self.live.update(self._renderable(), refresh=True)

    def _append(self, row):
        with self.lock:
            if self.frozen: return
            self.rows.append(row)
            self.rows = self.rows[-self.MAX_ROWS:]
            self._refresh()

    def step(self, icon, label):
        with self.lock:
            if self.frozen: return
            if self.cur: self.done()
            self.cur = {"icon": icon, "label": label, "t0": time.monotonic()}
            self._append(self._row(icon, label, "running"))

    def done(self, note="✓", color="green"):
        with self.lock:
            if not self.cur: return
            elapsed = int(time.monotonic() - self.cur["t0"])
            state = "waiting" if note in ("⏸", "⏸ Lagi nunggu") else "done" if note == "✓" else "error"
            if self.rows and not self.frozen:
                self.rows[-1] = self._row(self.cur["icon"], self.cur["label"], state, elapsed)
                if self.live: self.live.update(self._renderable(), refresh=True)
            self.cur = None

    def suspend(self):
        with self.lock:
            self.frozen = True
            self._stop_live()

    def resume(self):
        with self.lock:
            self.frozen = False
            self._start_live()
            self._refresh()

    def ask(self, reason, command):
        self.suspend()
        console.print()
        try:
            return _ask_permission(reason, command)
        finally:
            self.resume()

    def below(self, text):
        self._stop_live()
        console.print("  " + text)
        if not self.frozen:
            self._start_live()
            self._refresh()

    def close(self):
        with self.lock:
            self.closed = True
            self._stop_live()
            self.cur = None
            self.frozen = False

class Tools:
    def __init__(self, cfg):
        self.base, self.token, self.cwd = f"http://127.0.0.1:{cfg['TOOLS_PORT']}", cfg["TOOLS_TOKEN"], PROJECT_ROOT
    def _post(self, path, body):
        try: return requests.post(f"{self.base}{path}", headers={"Content-Type": "application/json", "x-tools-token": self.token}, json={**body, "token": self.token}, timeout=1800).json()
        except Exception as e: return {"error": str(e)}
    def exec(self, cmd, cwd=None, approved=False): return self._post("/api/exec", {"command": cmd, "cwd": cwd or self.cwd, "approved": approved})
    def read(self, path): return self._post("/api/fs_read", {"path": path})
    def write(self, path, content, append=False): return self._post("/api/fs_write", {"path": path, "content": content, "append": append})
    def list(self, path): return self._post("/api/fs_list", {"path": path})
    def search(self, pattern, path=PROJECT_ROOT, content=False): return self._post("/api/fs_search", {"pattern": pattern, "path": path, "content": content})
    def http_request(self, url, method="GET", headers=None, body=None, timeout=20): return self._post("/api/http", {"url": url, "method": method, "headers": headers or {}, "body": body, "timeout": timeout})
    def download(self, url, path, max_mb=200, timeout=120): return self._post("/api/download", {"url": url, "path": path, "max_mb": max_mb, "timeout": timeout})
    def db(self, db_path, sql, params=None): return self._post("/api/db", {"db_path": db_path, "sql": sql, "params": params or []})
    def archive(self, action, archive_path, files=None, target_dir=None): return self._post("/api/archive", {"action": action, "archive_path": archive_path, "files": files or [], "target_dir": target_dir})
    def ps(self, pattern=None): return self._post("/api/ps", {"pattern": pattern or ""})
    def kill(self, pid=None, pattern=None, signal=15): return self._post("/api/kill", {"pid": pid, "pattern": pattern or "", "signal": signal})
    def skill(self, action, name=None, category=None, content=None, pattern=None): return self._post("/api/skill", {"action": action, "name": name, "category": category, "content": content, "pattern": pattern})
    def note(self, action, key=None, content=None, pattern=None): return self._post("/api/note", {"action": action, "key": key, "content": content, "pattern": pattern})
    def pkg(self, action, package=None): return self._post("/api/pkg", {"action": action, "package": package or ""})

ALLOW_ALL_FILE = os.path.join(PROJECT_ROOT, ".approval_always")

def _allow_all_get() -> bool:
    return os.path.isfile(ALLOW_ALL_FILE)

def _allow_all_set(on: bool) -> bool:
    try:
        if on:
            with open(ALLOW_ALL_FILE, "w") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%S"))
        elif os.path.isfile(ALLOW_ALL_FILE):
            os.remove(ALLOW_ALL_FILE)
    except Exception:
        pass
    return _allow_all_get()

class Agent:
    def __init__(self, cfg, tty):
        self.cfg, self.tty, self.history, self.pending, self.tools_on, self.tools = cfg, tty, [], None, True, Tools(cfg)
        self.allow_all, self.allow_session = _allow_all_get(), False
        self.system = (
    f"You are {BRAND_NAME}, a smart and efficient personal AI assistant integrated into Debz Phone CLI. "
    f"Gunakan gaya bahasa Indonesia yang santai tapi profesional (semi-kasual). "
    f"Fokus pada efisiensi: berikan solusi langsung, gunakan bullet points untuk instruksi, "
    f"dan sertakan blok kode/perintah terminal jika diperlukan. Jangan bertele-tele."
)
    
    def _llm(self, msgs):
        max_tokens = int(self.cfg.get("MAX_OUTPUT_TOKENS") or self.cfg.get("MAX_TOKENS") or 16384)
        body = {"model": self.cfg["MODEL"], "messages": msgs, "max_tokens": max_tokens}

        if self.tools_on:
            body["tools"] = self.TOOLS_SCHEMA

        is_openrouter = "openrouter.ai" in self.cfg.get("ENDPOINT", "").lower()

        for key, value in (self.cfg.get("EXTRA") or {}).items():
            if key in TRANSPORT_KEYS or value is None: continue
            if key == "reasoning" and isinstance(value, dict) and not is_openrouter: continue
            if isinstance(value, (dict, list, str, int, float, bool)):
                body[key] = value

        try:
            r = requests.post(self.cfg["ENDPOINT"], headers=_get_headers(self.cfg), json=body, timeout=1800)
        except requests.exceptions.RequestException as e:
            raise PermanentError(f"HTTP Request Timeout / Terputus: {str(e)}")
        
        if not r.text.strip(): raise PermanentError("API provider mengembalikan response kosong (empty stream/message).")
        
        if not r.ok:
            try:
                err_json = r.json()
                err_msg = str(err_json.get("error", {}).get("message", err_json.get("error", r.text)))
            except Exception: err_msg = r.text
            
            if self.tools_on and r.status_code in (400, 422) and any(k in err_msg.lower() for k in ("tool", "function", "support", "invalid type")):
                self.tools_on = False
                body.pop("tools", None)
                try: r = requests.post(self.cfg["ENDPOINT"], headers=_get_headers(self.cfg), json=body, timeout=1800)
                except requests.exceptions.RequestException as e: raise PermanentError(f"HTTP Request Timeout / Terputus saat retry: {str(e)}")
                if r.ok:
                    try:
                        d = r.json()
                        if "error" in d and isinstance(d["error"], dict): raise PermanentError(str(d["error"]))
                        return d.get("choices", [{}])[0].get("message", {})
                    except json.JSONDecodeError: raise PermanentError("Gagal parse JSON dari API setelah retry tanpa tools.")
            
            if r.status_code in (429, 500, 502, 503, 504, 529): raise OverloadedError(f"HTTP {r.status_code}: {err_msg[:100]}")
            raise PermanentError(f"HTTP {r.status_code}: {err_msg[:200]}")
        
        try: d = r.json()
        except json.JSONDecodeError: raise PermanentError(f"API provider merespon dengan data non-JSON yang rusak:\n{r.text[:200]}")
        if "error" in d and isinstance(d["error"], dict): raise PermanentError(str(d.get("error")))
        return d.get("choices", [{}])[0].get("message", {})

    TOOLS_SCHEMA = [
        {"type": "function", "function": {"name": "shell", "description": "Run shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}, "cwd": {"type": "string"}}, "required": ["command"]}}},
        {"type": "function", "function": {"name": "read_file", "description": "Read file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": "function", "function": {"name": "write_file", "description": "Write file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
        {"type": "function", "function": {"name": "list_dir", "description": "List dir", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": "function", "function": {"name": "search", "description": "Search files", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}, "content": {"type": "boolean"}}, "required": ["pattern"]}}},
        {"type": "function", "function": {"name": "http_request", "description": "Fetch URL", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"]}, "headers": {"type": "object"}, "body": {"type": "string"}, "timeout": {"type": "integer"}}, "required": ["url"]}}},
        {"type": "function", "function": {"name": "download_file", "description": "DL file", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "path": {"type": "string"}, "max_mb": {"type": "integer"}}, "required": ["url", "path"]}}},
        {"type": "function", "function": {"name": "db_query", "description": "Query SQLite", "parameters": {"type": "object", "properties": {"db_path": {"type": "string"}, "sql": {"type": "string"}, "params": {"type": "array"}}, "required": ["db_path", "sql"]}}},
        {"type": "function", "function": {"name": "archive", "description": "Archive", "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ["create", "extract"]}, "archive_path": {"type": "string"}, "files": {"type": "array"}, "target_dir": {"type": "string"}}, "required": ["action", "archive_path"]}}},
        {"type": "function", "function": {"name": "process_list", "description": "List procs", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}}}},
        {"type": "function", "function": {"name": "process_kill", "description": "Kill proc", "parameters": {"type": "object", "properties": {"pid": {"type": "integer"}, "pattern": {"type": "string"}, "signal": {"type": "integer"}}}}},
        {"type": "function", "function": {"name": "skill", "description": "Knowledge base skills (list/search/get/create/delete/stats)", "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "search", "get", "create", "delete", "stats"]}, "name": {"type": "string"}, "category": {"type": "string"}, "content": {"type": "string"}, "pattern": {"type": "string"}}, "required": ["action"]}}},
        {"type": "function", "function": {"name": "note", "description": "AI memory", "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "get", "add", "delete", "search"]}, "key": {"type": "string"}, "content": {"type": "string"}, "pattern": {"type": "string"}}, "required": ["action"]}}},
        {"type": "function", "function": {"name": "app_install", "description": "Pkg mgr", "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ["search", "install", "remove", "update", "installed"]}, "package": {"type": "string"}}, "required": ["action"]}}}
    ]

    def _cooldown_wait(self, tree=None):
        total, t0, first = COOLDOWN, time.time(), True
        while True:
            left = total - (time.time() - t0)
            if left <= 0: return True
            txt = f"[yellow]⏳ cooldown[/yellow] [yellow]{int(left)//60:02d}:{int(left)%60:02d}[/yellow] [dim]· Enter=retry · Ctrl+C=hold[/dim]"
            if first:
                if tree: tree.below(txt)
                else: console.print("  " + txt)
                first = False
            try:
                rdy, _, _ = select.select([sys.stdin], [], [], 1.0)
                if rdy: sys.stdin.readline(); return True
            except KeyboardInterrupt: return False

    def _fo_worthy(self, e):
        t = str(e).lower()
        return any(k in t for k in ("timeout", "terputus", "curl error", "http 5", "http 404", "http 401", "http 403", "http 429", "http 422"))

    def _fo_try(self, tree=None):
        if self.cfg.get("_ROUTING", "fixed") == "fixed": return False
        if getattr(self, "_fo_pool", None) is None:
            self._fo_pool = [pid for pid in _enabled_ids(self.cfg.get("_PROVIDERS") or {}) if pid != self.cfg.get("_PROV_ID")]
        if not self._fo_pool: return False
        pid = self._fo_pool.pop(0)
        cur = self.cfg.get("_PROV_ID", "?")
        if tree: tree.below(f"[yellow]🔄 FAILOVER: {cur} error → coba {pid}[/yellow]")
        if not _apply_provider(self.cfg, pid, mark_active=False): return False
        return True

    def _llm_retry(self, msgs, tree=None):
        attempt = 0
        while True:
            try: return self._llm(msgs)
            except OverloadedError as e:
                if self._fo_try(tree): continue
                attempt += 1
                if tree: tree.done("⏸", "yellow"); tree.below(f"[yellow]⚠ {self.cfg['MODEL']} overload · {e}[/yellow]")
                if attempt >= MAX_RETRY or not self._cooldown_wait(tree): raise HoldSignal(str(e))
                if tree: tree.step("🧠", "Lagi mikir")
            except PermanentError as e:
                if self._fo_worthy(e) and self._fo_try(tree): continue
                raise
            except KeyboardInterrupt:
                if tree: tree.done("✗", "red")
                raise PermanentError("Request dibatalin 🚷 (Ctrl+C)")

    def _shell_out(self, r):
        if "error" in r: return {"output": "error: " + str(r["error"]), "ok": False}
        return {"output": (r.get("stdout", "") + ("\n[stderr] " + r.get("stderr", "") if r.get("stderr", "") else "")).strip(), "ok": r.get("exit_code") in (0, None)}

    def _show_diff(self, path, new_content):
        try:
            with open(path, 'r', encoding='utf-8') as f: old_lines = f.readlines()
        except Exception: old_lines = []
        diff = list(difflib.unified_diff(old_lines, new_content.splitlines(keepends=True), n=2))
        if not diff:
            console.print("  [dim](tidak ada perubahan)[/dim]")
            return
        
        diff_lines = []
        new_line_no = 0
        max_show = 25
        
        for line in diff:
            line_str = line.rstrip('\n')
            if line_str.startswith('@@'):
                match = re.search(r'\+(\d+)', line_str)
                if match:
                    new_line_no = int(match.group(1)) - 1
                diff_lines.append(Text(f"  {line_str}", style=THEME["cyan"]))
                continue
            
            if line_str.startswith('+') and not line_str.startswith('+++'):
                new_line_no += 1
                prefix = f"{new_line_no:4d} │ + "
                diff_lines.append(Text(prefix + line_str[1:], style=f"{THEME['text']} on #263323"))
            elif line_str.startswith('-') and not line_str.startswith('---'):
                prefix = f"     │ - "
                diff_lines.append(Text(prefix + line_str[1:], style=f"{THEME['text']} on #382424"))
            elif line_str.startswith(' '):
                new_line_no += 1
                prefix = f"{new_line_no:4d} │   "
                diff_lines.append(Text(prefix + line_str[1:], style="dim"))

        if len(diff_lines) > max_show:
            rendered_lines = diff_lines[:max_show]
            rendered_lines.append(Text(f"  ... [{len(diff_lines) - max_show} baris diff disembunyikan]", style="dim"))
        else:
            rendered_lines = diff_lines

        panel = Panel(
            Group(*rendered_lines),
            title=Text(f" DIFF: {os.path.basename(path)} ", style=THEME["cyan"]),
            title_align="left",
            border_style=THEME["border"],
            padding=(0, 1),
        )
        panel.style = f"on {THEME['surface']}"
        console.print()
        console.print(panel)

    def _run_tool(self, name, args, tree):
        if name == "shell":
            r = self.tools.exec(args.get("command"), args.get("cwd"))
            return r if r.get("need_approval") else self._shell_out(r)
        if name == "read_file":
            r = self.tools.read(args.get("path", ""))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": r.get("content", "")[:20000], "ok": True}
        if name == "write_file":
            p, c_str = args.get("path", ""), args.get("content", "")
            self._show_diff(p, c_str)
            r = self.tools.write(p, c_str)
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": f"wrote {r.get('bytes_written', '?')} bytes", "ok": True}
        if name == "list_dir":
            r = self.tools.list(args.get("path", "/"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": "\n".join(f"{'d' if e['dir'] else '-'}  {e['name']}  {e['size']}b" for e in r.get("entries", [])[:100]) or "(empty)", "ok": True}
        if name == "search":
            r = self.tools.search(args.get("pattern", ""), path=args.get("path", PROJECT_ROOT), content=bool(args.get("content", False)))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": "\n".join(f"{m.get('path', '?')} [{m.get('match', '?')}]" if isinstance(m, dict) else str(m) for m in r.get("results", [])[:50]) or "(no matches)", "ok": True}
        if name == "http_request":
            r = self.tools.http_request(args.get("url", ""), method=args.get("method", "GET"), headers=args.get("headers"), body=args.get("body"), timeout=args.get("timeout", 20))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": f"HTTP {r.get('http_code')}\n{r.get('body', '')[:4000]}", "ok": True}
        if name == "download_file":
            r = self.tools.download(args.get("url", ""), args.get("path", ""), max_mb=args.get("max_mb", 200))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": f"downloaded {r.get('bytes', 0)} bytes", "ok": True}
        if name == "db_query":
            db_path = args.get("db_path", "")
            sql = args.get("sql", "")
            if not db_path or not sql: return {"output": "error: db_path atau sql kosong", "ok": False}
            r = self.tools.db(db_path, sql, args.get("params"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": "\n".join(str(row) for row in r.get("rows", [])[:50]) if "rows" in r else f"{r.get('affected', 0)} rows changed", "ok": True}
        if name == "archive":
            action = args.get("action", "")
            archive_path = args.get("archive_path", "")
            if action not in ("create", "extract"): return {"output": "error: action harus create atau extract", "ok": False}
            if not archive_path: return {"output": "error: archive_path kosong", "ok": False}
            r = self.tools.archive(action, archive_path, files=args.get("files"), target_dir=args.get("target_dir"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": json.dumps(r)[:2000], "ok": True}
        if name == "process_list":
            r = self.tools.ps(args.get("pattern"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": "\n".join(f"{p.get('pid')} {p.get('user', '?')} {p.get('cmd', '')[:80]}" for p in r.get("processes", [])[:50]), "ok": True}
        if name == "process_kill":
            r = self.tools.kill(pid=args.get("pid"), pattern=args.get("pattern"), signal=args.get("signal", 15))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": f"signal {r.get('signal')}", "ok": True}
        if name == "note":
            r = self.tools.note(args.get("action", ""), key=args.get("key"), content=args.get("content"), pattern=args.get("pattern"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": json.dumps(r)[:2000], "ok": True}
        if name == "app_install":
            r = self.tools.pkg(args.get("action", ""), args.get("package"))
            return {"output": "error: " + r["error"], "ok": False} if "error" in r else {"output": (r.get("stdout") or "")[:3000], "ok": r.get("exit_code", 0) == 0}
        return {"output": f"unknown tool: {name}", "ok": False}

    def chat(self, user_msg, ui, resume_msgs=None):
        self._fo_pool = None
        used, mx, pct = memory_usage(self)
        if pct > 85 and len(self.history) > 4:
            self.history = self.history[len(self.history)//2:]
            if self.tty: console.print("  [dim yellow]⚠ Memory auto-trimmed (mencegah token limit)[/dim yellow]")

        if resume_msgs is None: self.history.append({"role": "user", "content": user_msg})
        msgs = resume_msgs if resume_msgs is not None else ([{"role": "system", "content": self.system}] + self.history)
        tree = WorkTree(self.tty)
        final_text, held = "", False
        try:
            tree.step("🧠", "Lagi mikir")
            for _ in range(self.cfg["MAX_ITER"]):
                msg = self._llm_retry(msgs, tree)
                tc_list = msg.get("tool_calls") or []
                if not tc_list:
                    tree.done("✓")
                    final_text = (msg.get("content") or "").strip() or "(empty)"
                    self.history.append({"role": "assistant", "content": final_text})
                    tree.close()
                    ui.ai_box(final_text)
                    return final_text
                tree.done("✓")
                msgs.append(msg)
                for tc in tc_list:
                    fn = tc.get("function", {})
                    name, args_str = fn.get("name", ""), fn.get("arguments") or "{}"
                    try: args = json.loads(args_str)
                    except json.JSONDecodeError: args = {}
                    icon, label = TOOL_ICONS_MAP.get(name, "⚙️"), _get_dynamic_label(name, args)
                    tree.step(icon, label)
                    result = self._run_tool(name, args, tree)
                    if isinstance(result, dict) and result.get("need_approval"):
                        if self.allow_all or self.allow_session:
                            tree.below(f"[yellow]🔓 auto-approve ({'always' if self.allow_all else 'session'})[/yellow]")
                            result = self._shell_out(self.tools.exec(result["command"], approved=True))
                        else:
                            tree.done("⏸ Lagi nunggu", "yellow")
                            choice = tree.ask(result.get("reason", ""), result.get("command", ""))
                            if choice == "deny":
                                tree.below("[red]✗ denied[/red]")
                                msgs.append({"role": "tool", "tool_call_id": tc.get("id"), "content": "user denied"})
                                continue
                            if choice == "session": self.allow_session = True
                            elif choice == "always": self.allow_all = True; _allow_all_set(True)
                            tree.step(icon, label + " (run)")
                            result = self._shell_out(self.tools.exec(result["command"], approved=True))
                    tree.done("✗" if not result.get("ok", True) else "✓", "red" if not result.get("ok", True) else "green")
                    msgs.append({"role": "tool", "tool_call_id": tc.get("id"), "content": (result.get("output", "")[:20000] or "(no output)")})
                tree.step("🧠", "Lagi mikir")
        except PermanentError as e:
            if resume_msgs is None and self.history and self.history[-1].get("role") == "user": self.history.pop()
            final_text = f"X model error - {e}"
        except HoldSignal:
            held = True; final_text = ""
        finally:
            try: tree.close()
            except Exception: pass
        if held: self.pending = (user_msg, msgs); return None
        ui.ai_box(final_text)
        return final_text
    
    def reset(self): self.history = []

def memory_usage(agent):
    text_total = agent.system + ""
    for h in agent.history:
        text_total += (h.get("content") or "")
    words = len(text_total.split())
    chars = len(text_total)
    used = max(int(words * 1.3), chars // 4)
    mx = agent.cfg.get("MAX_TOKEN", 128000)
    return used, mx, min(100.0, used / max(mx, 1) * 100)

MODEL_BAD_KEYS = ("image", "video", "audio", "tts", "embed", "whisper", "realtime", "flux", "veo", "dall", "sora", "moderation", "transcribe", "seedance", "voice", "stt")
_MODEL_CACHE = {}

def _prov_models(pc, timeout=12):
    h = {"Authorization": "Bearer " + (pc.get("key") or ""), "Content-Type": "application/json"}
    e = pc.get("extra") or {}
    h["User-Agent"] = _sanitize_ua(e.get("user_agent") or UA_OK_HARNESS)
    for hk, hv in (e.get("headers") or {}).items():
        if hv is None or str(hv) == "": continue
        h[str(hk)] = str(hv)
    b = pc["endpoint"]
    for s in ("/chat/completions", "/completions"):
        if b.endswith(s): b = b[:-len(s)]; break
    try:
        r = requests.get(b.rstrip("/") + "/models", headers=h, timeout=timeout)
        if not r.ok: return []
        data = r.json()
    except Exception: return []
    out = []
    for m in data.get("data") or []:
        mid = (m.get("id") or "").strip()
        if not mid or any(k in mid.lower() for k in MODEL_BAD_KEYS): continue
        mods = m.get("modalities")
        if isinstance(mods, list) and mods:
            low = [str(x).lower() for x in mods]
            if "text" not in low and "chat" not in low: continue
        out.append(mid)
    return sorted(set(out))

def fetch_all_models(cfg, force=False):
    result = {}
    for pid, p in (cfg.get("_PROVIDERS") or {}).items():
        if not force and pid in _MODEL_CACHE: result[pid] = _MODEL_CACHE[pid]; continue
        pc = _provider_cfg(p, cfg)
        if not pc["key"]: pc["key"] = cfg.get("API_KEY", "")
        try: ms = _prov_models(pc); _MODEL_CACHE[pid] = ms
        except Exception: ms = []
        result[pid] = ms
    return result

def probe_model(cfg, model, timeout=20):
    body = {"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 5}
    h = _get_headers(cfg)
    try: r = requests.post(cfg["ENDPOINT"], headers=h, json=body, timeout=timeout)
    except requests.exceptions.RequestException: return True, "probe timeout - model tetap dipilih"
    if r.status_code in (401, 402, 403):
        try: emsg = (r.json().get("error") or {}).get("message", "")[:90]
        except Exception: emsg = ""
        if r.status_code == 403 and "agentic harness" in (emsg or "").lower():
            h["User-Agent"] = UA_OK_HARNESS
            try: r = requests.post(cfg["ENDPOINT"], headers=h, json=body, timeout=timeout)
            except requests.exceptions.RequestException: return False, "probe gagal saat retry UA harness"
            if r.status_code == 200: return True, "OK (retry UA harness lolos gate)"
        return False, f"HTTP {r.status_code} - {emsg or 'akses ditolak'}"
    return True, ""

def _switch_model(cfg, pid, m):
    provs = cfg.get("_PROVIDERS") or {}
    pc = _provider_cfg(provs.get(pid, {}), cfg)
    if not pc["key"]: pc["key"] = cfg.get("API_KEY", "")
    console.print(f"  [dim]… test[/dim] {m} [dim]@ {pid}[/dim]")
    try: ok, why = probe_model({"ENDPOINT": pc["endpoint"], "API_KEY": pc["key"], "MODEL": m, "EXTRA": pc["extra"]}, m)
    except Exception: ok, why = True, ""
    if not ok:
        console.print(f"  [red]✗ GAGAL[/red] {why}")
        return False
    if not _set_active_provider(pid, m):
        console.print("  [red]✗ gagal simpan .ai-providers.json[/red]")
        return False
    cfg["_CLI_MODEL"] = ""
    cfg["MODEL"], cfg["ENDPOINT"], cfg["API_KEY"] = m, pc["endpoint"], pc["key"]
    cfg["EXTRA"] = pc["extra"] or {}
    cfg["_PROV_ID"] = pid
    console.print(f"  [green]✓ model →[/green] {m}\n  [green]✓ provider[/green] {pid} [dim]· tersinkron ke webui[/dim]")
    return True

COMMANDS = ["/help", "/status", "/providers", "/sid", "/model", "/tools", "/routing", "/bypass", "/memory", "/reset", "/new", "/clear", "/copy", "/retry", "/exit", "/quit", "/save", "/load", "/export", "/system"]

class CommandPathCompleter(Completer):
    def _filesystem_completions(self, token):
        if not token: token = "./"
        expanded = os.path.expanduser(token)
        if os.path.isdir(expanded): pattern = os.path.join(expanded, "*")
        else: pattern = expanded + "*"
        seen = set()
        try: matches = sorted(glob.glob(pattern))
        except Exception: matches = []
        for match in matches:
            shown = os.path.expanduser(match)
            if os.path.isdir(match): shown += "/"
            if token.startswith("~/"):
                home = os.path.expanduser("~")
                if shown.startswith(home): shown = "~" + shown[len(home):]
            if shown in seen: continue
            seen.add(shown)
            yield shown

    def _complete_paths(self, document, token):
        start_position = -len(token)
        for path in self._filesystem_completions(token):
            yield Completion(path, start_position=start_position, display=path, display_meta="path")

    def get_completions(self, document, complete_event):
        text = document.text
        if text.startswith('/model '):
            word = document.get_word_before_cursor()
            for pid in sorted(_MODEL_CACHE):
                for model in _MODEL_CACHE[pid]:
                    if model.lower().startswith(word.lower()): yield Completion(model, start_position=-len(word), display=model, display_meta=f"model · {pid}")
            return
        if text.startswith('/load '):
            token = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
            yield from self._complete_paths(document, token)
            return
        if text.startswith('! '):
            token = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
            yield from self._complete_paths(document, token)
            return
        if text.startswith('/') and ' ' not in text:
            for cmd in COMMANDS:
                if cmd.lower().startswith(text.lower()): yield Completion(cmd, start_position=-len(text), display=cmd, display_meta="command")
            yield from self._complete_paths(document, text)
            return
        
        text_before = document.text_before_cursor
        last_space = text_before.rfind(' ')
        token = text_before[last_space + 1:] if last_space != -1 else text_before

        if token.startswith(('/', './', '../', '~/')):
            yield from self._complete_paths(document, token)

def print_help():
    console.print("  [dim]" + "-" * 36 + "[/dim]")
    for cmd, desc in [("/help", "help"), ("/status", "status"), ("/model", "ganti model"), ("/providers", "list provider"), ("/sid", "generate x-session-id"), ("/routing", "mode fixed|roundrobin|failover"), ("/bypass", "cek UA & params harness"), ("/retry", "lanjut pesan hold"), ("/tools", "toggle tools"), ("/allow", "allow-all on|off"), ("/memory", "memory"), ("/reset", "reset chat"), ("/clear", "clear screen"), ("/copy", "salin full balasan AI"), ("/save", "simpan session"), ("/load", "muat session"), ("/export", "export chat ke .md"), ("/system", "ganti persona AI"), ("/exit", "keluar"), ("! cmd", "shell command")]:
        console.print(f"  [cyan]{cmd.ljust(9)}[/cyan] {desc}")
    console.print("  [dim]" + "-" * 36 + "[/dim]")

def main():
    parser = argparse.ArgumentParser(prog="debz_ai")
    parser.add_argument("--model"); parser.add_argument("--exec"); parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    cfg = _load_config()
    if args.model: cfg["MODEL"] = cfg["_CLI_MODEL"] = args.model
    tty = sys.stdout.isatty()
    ui, agent = UI(), Agent(cfg, tty)

    if args.exec:
        ui.banner(cfg, agent.tools_on)
        _rotate_for_rr(cfg); agent.cfg = cfg
        ui.user_box(args.exec)
        result = agent.chat(args.exec, ui)
        output = {"status": "ok" if result is not None else "hold", "result": result, "pending": agent.pending is not None}
        if args.json: print(json.dumps(output, ensure_ascii=False))
        else:
            if result is None: console.print("  [yellow]⚠ pesan dihold[/yellow]")
            else: ui.memory_bar(*memory_usage(agent))
            log_debug(f"exec: model={cfg['MODEL']} result={result is not None}")
        return

    if not cfg.get("API_KEY"): console.print("  [yellow]⚠ PERINGATAN:[/yellow] API_KEY kosong! Cek .ai-providers.json / .ai-config.ini")
    if not cfg.get("MODEL"): console.print("  [yellow]⚠ PERINGATAN:[/yellow] MODEL kosong!")
    
    server_ok = check_tools_server(cfg)
    if not server_ok: console.print(f"  [dim yellow]⚠ Tools server {cfg['TOOLS_PORT']} tidak terdeteksi (bisa lanjut tanpa tools)[/dim yellow]")
    else: console.print(f"  [dim green]✓ Tools server {cfg['TOOLS_PORT']} aktif[/dim green]")
    
    ui.banner(cfg, agent.tools_on)
    ui.memory_bar(*memory_usage(agent))
    threading.Thread(target=lambda: fetch_all_models(cfg), daemon=True).start()

    style = Style.from_dict({
        "prompt.border": f"{THEME['border_focus']}",
        "prompt.label": f"{THEME['green']}",
        "prompt.text": f"{THEME['text']}",
        "prompt.hint": f"{THEME['muted']}",
        "completion-menu": f"bg:{THEME['surface']} {THEME['text']}",
        "completion-menu.completion": f"bg:{THEME['surface']} {THEME['text']}",
        "completion-menu.completion.current": f"bg:{THEME['surface_alt']} {THEME['green']}",
        "scrollbar.background": f"bg:{THEME['surface']}",
        "scrollbar.button": f"bg:{THEME['border']}",
    })

    session = PromptSession(
        completer=CommandPathCompleter(),
        complete_style=CompleteStyle.MULTI_COLUMN,
        complete_while_typing=True,
        reserve_space_for_menu=8,
        style=style,
        erase_when_done=True,
        multiline=False,
    )

    while True:
        refresh_cfg(cfg)
        agent.cfg = cfg

        prompt_message = FormattedText([
            ("class:prompt.border", "╭─"),
            ("class:prompt.label", " Debz AI 💬 "),
            ("class:prompt.border", "──────────────────────────────╮\n"),
            ("class:prompt.border", "╰─"),
            ("class:prompt.label", "❯ "),
        ])

        try:
            line = session.prompt(
                prompt_message,
                bottom_toolbar=FormattedText([
                    ("class:prompt.hint", "  Enter kirim  /  Tab lengkap  /  Ctrl+C batal  "),
                ]),
            )
        except (EOFError, KeyboardInterrupt):
            console.print(Text("👻 bye", style=THEME["green_soft"]))
            break

        c_line = line.strip()
        if not c_line: continue

        if c_line in ("/exit", "/quit"):
            console.print("  [green]bye 👋[/green]")
            break
        elif c_line == "/help": print_help()
        elif c_line == "/clear": os.system("clear"); ui.banner(cfg, agent.tools_on); ui.memory_bar(*memory_usage(agent))
        elif c_line == "/copy":
            last_ai = next((h["content"] for h in reversed(agent.history) if h["role"] == "assistant"), "")
            if last_ai:
                try: subprocess.run(["termux-clipboard-set"], input=last_ai.encode("utf-8"), check=True); console.print("  [green]✓ Disalin ke clipboard![/green]")
                except Exception:
                    try:
                        with open(os.path.join(PROJECT_ROOT, "last_response.txt"), "w", encoding="utf-8") as f: f.write(last_ai)
                        console.print("  [green]✓ Disimpan ke " + os.path.join(PROJECT_ROOT, "last_response.txt") + "[/green]")
                    except Exception: pass
            else: console.print("  [yellow]⚠ Belum ada balasan AI.[/yellow]")
        elif c_line.startswith("/export"):
            md_file = os.path.join(PROJECT_ROOT, f"export_{time.strftime('%Y%m%d_%H%M%S')}.md")
            try:
                with open(md_file, "w", encoding="utf-8") as f:
                    f.write(f"# Chat Export - {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                    f.write(f"**Model:** {cfg['MODEL']}\n**System:** {agent.system}\n\n---\n\n")
                    for h in agent.history:
                        role = "👾 **ROOT**" if h["role"] == "user" else "👻 **Debz AI**"
                        f.write(f"{role}\n\n{h['content']}\n\n---\n\n")
                console.print(f"  [green]✓ Chat berhasil diexport → {md_file}[/green]")
            except Exception as e: console.print(f"  [red]✗ gagal export: {e}[/red]")
        elif c_line.startswith("/system"):
            parts = c_line.split(maxsplit=1)
            if len(parts) > 1:
                agent.system = parts[1].strip()
                console.print(f"  [green]✓ System prompt diubah:[/green] {agent.system}")
            else: console.print(f"  [cyan]System prompt saat ini:[/cyan] {agent.system}")
        elif c_line == "/status":
            console.print("  [dim]" + "-" * 36 + "[/dim]")
            if cfg.get("_PROV_ID"): console.print(f"  [cyan]provider[/cyan]  [magenta]{cfg.get('_PROV_ID')}[/magenta]")
            console.print(f"  [cyan]model[/cyan]    {cfg['MODEL']}\n  [cyan]routing[/cyan]  {cfg.get('_ROUTING', 'fixed')}\n  [cyan]UA[/cyan]      {_get_headers(cfg).get('User-Agent')}\n  [cyan]turns[/cyan]    {len(agent.history) // 2}")
            if agent.pending: console.print("  [cyan]pending[/cyan]  [yellow]⚠ ada hold · /retry[/yellow]")
            ui.memory_bar(*memory_usage(agent))
            console.print("  [dim]" + "-" * 36 + "[/dim]")
        elif c_line == "/providers":
            console.print("  [dim]" + "-" * 36 + "[/dim]" + "\n  [cyan]providers[/cyan] · routing [magenta]" + str(cfg.get('_ROUTING', 'fixed')) + "[/magenta]")
            for pid, p in (cfg.get("_PROVIDERS") or {}).items():
                mark = ' [green]← aktif[/green]' if pid == cfg.get("_PROV_ID") else ''
                en = '[green]ON[/green]' if (p.get("enabled", True) is not False) else '[dim]off[/dim]'
                console.print(f"  [magenta]▸[/magenta] {pid} [{en}]{mark}\n      [dim]{p.get('base_url', '?')}[/dim]")
            console.print("  [dim]" + "-" * 36 + "[/dim]")
        elif c_line.startswith("/sid"):
            refresh_cfg(cfg); agent.cfg = cfg
            parts = c_line.split(maxsplit=1)
            arg = parts[1].strip() if len(parts) == 2 else ""
            pid = cfg.get("_PROV_ID", "")
            provs = cfg.get("_PROVIDERS") or {}
            p = provs.get(pid, {})
            sid_now = ((p.get("extra") or {}).get("headers") or {}).get("x-session-id", "")
            if arg in ("", "cek", "show", "status"):
                console.print("  [dim]" + "-" * 36 + "[/dim]")
                console.print(f"  [cyan]provider[/cyan]  [magenta]{pid or '-'}[/magenta]")
                if sid_now:
                    console.print(f"  [cyan]session id[/cyan] {sid_now}")
                else:
                    console.print("  [yellow]⚠ belum ada x-session-id[/yellow] [dim]· /sid gen buat bikin baru[/dim]")
                console.print("  [dim]· /sid gen | /sid gen all | /sid gen <nama> | /sid set <uuid> | /sid del[/dim]")
                console.print("  [dim]" + "-" * 36 + "[/dim]")
            elif arg in ("gen", "generate", "new", "fresh") or arg.startswith(("gen ", "generate ")):
                sub = arg.split(None, 1)[1].strip() if len(arg.split(None, 1)) > 1 else ""
                targets = {}
                if sub == "all":
                    targets = {q: qp for q, qp in provs.items() if (qp.get("enabled", True) is not False)}
                elif sub:
                    if sub in provs: targets = {sub: provs[sub]}
                    else:
                        console.print(f"  [red]✗ provider '{sub}' gak ketemu[/red]")
                        console.print("  [dim]· /sid gen all | /sid gen <nama> | /sid gen[/dim]")
                elif p and p.get("base_url"): targets = {pid: p}
                if not targets:
                    console.print("  [red]✗ gak ada target provider valid[/red]")
                    console.print("  [dim]· /sid gen = aktif | /sid gen all = semua | /sid gen <nama>[/dim]")
                else:
                    for tpid, tp in targets.items():
                        if not tp.get("base_url"):
                            console.print(f"  [dim]· {tpid}: [yellow]skip — gak ada base_url[/yellow]")
                            continue
                        console.print(f"  [dim]… generate {tpid}[/dim]")
                        sid, _, src = _gen_session_id(tp.get("base_url", ""), tp.get("api_key", ""), (tp.get("extra") or {}).get("user_agent", ""))
                        if not sid:
                            console.print(f"  [red]✗ {tpid}: gagal ({src})[/red]")
                            continue
                        _set_provider_sid(tpid, sid)
                        tag = "response endpoint" if src == "response" else "UUID v4 (endpoint ngasih tanpa header)"
                        console.print(f"  [green]✓ {tpid}[/green] {sid} [dim]· {tag}[/dim]")
                    refresh_cfg(cfg); agent.cfg = cfg
                    console.print("  [dim]· tersimpan ke .ai-providers.json → tersinkron ke webui[/dim]")
            elif arg == "del":
                if _set_provider_sid(pid, None):
                    refresh_cfg(cfg); agent.cfg = cfg
                    console.print("  [green]✓ x-session-id dihapus[/green] [dim]· tersinkron ke webui[/dim]")
                else: console.print("  [red]✗ gagal hapus[/red]")
            elif arg.startswith("set "):
                new_sid = arg[4:].strip()
                if not new_sid: console.print("  [red]✗ /sid set <uuid>[/red]")
                elif _set_provider_sid(pid, new_sid):
                    refresh_cfg(cfg); agent.cfg = cfg
                    console.print(f"  [green]✓ x-session-id diset:[/green] {new_sid}")
                    console.print("  [dim]  · tersimpan ke .ai-providers.json → tersinkron ke webui[/dim]")
                else: console.print("  [red]✗ gagal simpan[/red]")
            else:
                console.print("  [yellow]⚠ argumen gak dikenal:[/yellow] " + arg)
                console.print("  [dim]· /sid = cek | /sid gen = generate baru | /sid gen all = semua | /sid gen <nama> | /sid set <uuid> | /sid del[/dim]")
        elif c_line.startswith("/routing"):
            refresh_cfg(cfg); agent.cfg = cfg
            parts = c_line.split(maxsplit=1)
            if len(parts) == 2:
                mode = parts[1].strip().lower()
                if mode not in ("fixed", "roundrobin", "failover"): console.print("  [red]✗ mode harus fixed | roundrobin | failover[/red]")
                elif _set_routing(mode):
                    cfg["_ROUTING"] = mode
                    console.print(f"  [green]✓ routing →[/green] {mode} [dim]· tersinkron ke webui[/dim]")
                else: console.print("  [red]✗ gagal simpan routing[/red]")
            else:
                console.print(f"  [cyan]routing saat ini:[/cyan] {cfg.get('_ROUTING', 'fixed')}")
                console.print("  [dim]· /routing fixed | roundrobin | failover[/dim]")
                console.print("  [dim]  fixed      = selalu provider aktif[/dim]")
                console.print("  [dim]  roundrobin = ganti provider tiap pesan[/dim]")
                console.print("  [dim]  failover   = mulai aktif, pindah kalau error[/dim]")
        elif c_line.startswith("/bypass"):
            refresh_cfg(cfg); agent.cfg = cfg
            console.print("  [dim]" + "-" * 36 + "[/dim]")
            console.print("  [cyan]bypass harness (otomatis)[/cyan]")
            console.print(f"  [cyan]UA[/cyan]        {_get_headers(cfg).get('User-Agent')}")
            ex = cfg.get("EXTRA") or {}
            if ex:
                for k, v in ex.items():
                    dv = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v
                    console.print(f"  [cyan]{k}[/cyan]  {dv}")
            else: console.print("  [dim](tidak ada extra params — pakai default provider)[/dim]")
            console.print("  [dim]" + "-" * 36 + "[/dim]")
        elif c_line == "/memory": ui.memory_bar(*memory_usage(agent))
        elif c_line.startswith("/model"):
            refresh_cfg(cfg)
            agent.cfg = cfg
            parts = c_line.split(maxsplit=1)
            arg = parts[1].strip() if len(parts) == 2 else ""
            allm = fetch_all_models(cfg)
            flat = [(pid, m) for pid in sorted(allm) for m in allm[pid]]
            
            if arg and arg.lower() != "list":
                hit_pid, hit_m = None, None
                for pid in allm:
                    if arg in allm[pid]: hit_pid, hit_m = pid, arg; break
                if not hit_pid:
                    for pid in allm:
                        for m in allm[pid]:
                            if arg.lower() in m.lower(): hit_pid, hit_m = pid, m; break
                        if hit_pid: break
                if not hit_pid: console.print("  [red]✗ model gak ketemu[/red] [dim]· /model = list semua provider[/dim]")
                else: _switch_model(cfg, hit_pid, hit_m); agent.cfg = cfg
            else:
                total = len(flat)
                if not total: console.print("  [red]✗ daftar kosong / fetch gagal[/red]\n  [dim]· cek provider & api key di webui[/dim]")
                else:
                    search_session = PromptSession(style=style)
                    console.print("[cyan]Model AI :[/cyan]")
                    selected_choice = None
                    try:
                        sub_line = ""
                        while True:
                            try: sub_line = search_session.prompt(HTML("  <prompt.label> Cari 🔍 </prompt.label><prompt.border> ❯ </prompt.border> ")).strip().lower()
                            except (EOFError, KeyboardInterrupt): break
                            if not sub_line: break
                            
                            filtered_flat = [(pid, m) for pid, m in flat if sub_line in m.lower() or sub_line in pid.lower()]
                            if not filtered_flat:
                                console.print("  [yellow]⚠ Gak ketemu. Ketik keyword lain atau Enter untuk batal.[/yellow]")
                                continue
                            
                            console.print(f"  [dim]─[/dim] [green]Hasil Pencarian ({len(filtered_flat)})[/green] [dim]─[/dim]")
                            for idx, (pid, m) in enumerate(filtered_flat, 1):
                                is_cur = (pid == cfg.get("_PROV_ID") and m == cfg["MODEL"])
                                n_str = f"*{idx}" if is_cur else str(idx)
                                m_disp = f"{m} 🎁" if ":free" in m.lower() else m
                                c = "green" if is_cur else "white"
                                console.print(f"  [cyan]{n_str.rjust(3)}[/cyan] [dim]│[/dim] [{c}]{m_disp}[/{c}]")
                            
                            try: pick = console.input("  [cyan]pilih nomor / [Enter]=batal[/cyan] [dim]:[/dim] ").strip()
                            except KeyboardInterrupt: break
                                
                            if not pick: break
                            if pick.isdigit() and 1 <= int(pick) <= len(filtered_flat):
                                selected_choice = filtered_flat[int(pick) -1]
                                break
                            elif pick in [m for _, m in filtered_flat]:
                                selected_choice = next(x for x in filtered_flat if x[1] == pick)
                                break
                    except KeyboardInterrupt: pass
                    
                    if selected_choice:
                        if selected_choice[1] != cfg["MODEL"]: _switch_model(cfg, selected_choice[0], selected_choice[1]); agent.cfg = cfg
                        else: console.print("  [dim]· sudah aktif[/dim]")
        elif c_line.startswith("/tools"):
            if len(c_line.split()) == 2 and c_line.split()[1] in ("on", "off"):
                agent.tools_on = c_line.split()[1] == "on"
                console.print(f"  [green]✓ tools[/green] {c_line.split()[1]}")
        elif c_line == "/allow" or c_line.startswith("/allow "):
            arg = c_line[6:].strip().lower()
            if arg in ("on", "1", "yes"):
                agent.allow_all = True; _allow_all_set(True)
                console.print("  [green]✓ allow-all ON[/green] [dim]— perintah berbahaya auto-approve[/dim]")
            elif arg in ("off", "0", "no"):
                agent.allow_all = False; _allow_all_set(False)
                console.print("  [green]✓ allow-all OFF[/green]")
            else:
                console.print(f"  🔓 allow-all: {'ON' if agent.allow_all else 'OFF'} · 🕐 session: {'ON' if agent.allow_session else 'off'}  [dim]( /allow on|off )[/dim]")
        elif c_line in ("/reset", "/new"): agent.reset(); agent.pending = None; console.print("  [green]✓ cleared[/green]")
        elif c_line == "/save":
            session_file = os.path.join(PROJECT_ROOT, f"session_{time.strftime('%Y%m%d_%H%M%S')}.json")
            try:
                with open(session_file, "w", encoding="utf-8") as f: json.dump({"system": agent.system, "history": agent.history, "pending": agent.pending}, f, ensure_ascii=False, indent=2)
                console.print(f"  [green]✓ session disimpan → {session_file}[/green]")
            except Exception as e: console.print(f"  [red]✗ gagal save: {e}[/red]")
        elif c_line.startswith("/load"):
            files = sorted(glob.glob(os.path.join(PROJECT_ROOT, "session_*.json")))
            if not files: console.print("  [yellow]⚠ tidak ada session tersimpan[/yellow]")
            else:
                console.print("  [cyan]Session tersimpan:[/cyan]")
                for idx, fpath in enumerate(files[-10:], 1): console.print(f"  [dim]{idx}.[/dim] {os.path.basename(fpath)}")
                console.print("  [dim]ketik /load <nama_file> untuk load[/dim]")
                parts = c_line.split(maxsplit=1)
                if len(parts) == 2:
                    fname = parts[1].strip()
                    target = os.path.join(PROJECT_ROOT, fname) if not fname.startswith("/") else fname
                    try:
                        with open(target, "r", encoding="utf-8") as f: data = json.load(f)
                        agent.history = data.get("history", [])
                        agent.system = data.get("system", agent.system)
                        agent.pending = data.get("pending")
                        console.print(f"  [green]✓ session dimuat → {target}[/green]")
                    except Exception as e: console.print(f"  [red]✗ gagal load: {e}[/red]")
        elif c_line == "/retry":
            if agent.pending:
                pu, pm = agent.pending; agent.pending = None
                console.print("  [cyan]▶ lanjut hold[/cyan]"); ui.user_box(pu)
                if agent.chat(pu, ui, resume_msgs=pm) is None: console.print("  [yellow]⚠ masih overload[/yellow]")
                else: ui.memory_bar(*memory_usage(agent))
            else: console.print("  [dim]tidak ada hold[/dim]")
        elif c_line.startswith("!"):
            cmd = c_line[1:].strip()
            if cmd:
                ui.user_box(c_line)
                r = agent.tools.exec(cmd)
                if r.get("need_approval"):
                    if agent.allow_all or agent.allow_session:
                        console.print("  [yellow]🔓 auto-approve[/yellow]")
                        r = agent.tools.exec(cmd, approved=True)
                    else:
                        ans = _ask_permission("Jalankan perintah langsung?", cmd)
                        if ans == "once": r = agent.tools.exec(cmd, approved=True)
                        elif ans == "session": agent.allow_session = True; r = agent.tools.exec(cmd, approved=True)
                        elif ans == "always": agent.allow_all = True; _allow_all_set(True); r = agent.tools.exec(cmd, approved=True)
                        else: console.print("  [red]✗ denied[/red]"); continue
                out = "\n".join(filter(None, [r.get("stdout", ""), r.get("stderr", "")]))
                for ln in out.split("\n")[:40]: console.print(f"  [dim]│[/dim] {ln}")
                console.print(f"  [dim]└-exit {r.get('exit_code', '?')}[/dim]")
        else:
            if agent.pending:
                agent.pending = None
                if agent.history and agent.history[-1]["role"] == "user": agent.history.pop()
            refresh_cfg(cfg); agent.cfg = cfg
            _rotate_for_rr(cfg); agent.cfg = cfg
            ui.user_box(c_line)
            if agent.chat(c_line, ui) is None: console.print("  [yellow]⚠ dihold[/yellow] [dim]· /retry[/dim]")
            else: ui.memory_bar(*memory_usage(agent))

if __name__ == "__main__": main()
