#!/usr/bin/env python3
"""
cua_driver.py — CUA (Computer Use Agent) driver untuk Debz AI
=============================================================
"Tangan & mata" AI di server headless:
  - Xvfb    : layar virtual (gak perlu monitor fisik)
  - openbox : window manager ringan biar window bisa muncul
  - xdotool : eksekusi klik / ketik / scroll / drag
  - scrot   : screenshot (mata AI)

Endpoints (dipanggil backend.py):
  /api/cua        -> action: status|screenshot|open|close|click|dblclick|rightclick|
                             move|drag|type|key|scroll|meta
  /api/screenshot -> ambil screenshot terbaru (base64)
"""

import base64
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ================== KONFIGURASI ==================
CUA_DISPLAY = os.environ.get("CUA_DISPLAY", ":99")
CUA_SCREEN = os.environ.get("CUA_SCREEN", "1280x800x24")
BASE_DIR = Path(__file__).resolve().parent
SHOTS_DIR = BASE_DIR / "screenshots"
SHOTS_DIR.mkdir(exist_ok=True)
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

ENV = {**os.environ, "DISPLAY": CUA_DISPLAY}


# ================== DEPENDENCY CHECK ==================
def _check_cua_deps() -> dict:
    """Cek ketersediaan Xvfb, openbox, xdotool. Return dict {ok, missing}."""
    required = {"Xvfb": shutil.which("Xvfb"),
                "openbox": shutil.which("openbox"),
                "xdotool": shutil.which("xdotool")}
    missing = [name for name, path in required.items() if not path]
    if missing:
        print(f"[cua_driver] WARNING: Missing deps: {', '.join(missing)}", file=sys.stderr)
        print(f"[cua_driver] Install via: pkg install x11-repo && pkg install {' '.join(missing)}", file=sys.stderr)
    return {"ok": len(missing) == 0, "missing": missing}

# Jalankan sekali saat module load
_CUA_DEPS = _check_cua_deps()


# ================== BOOTSTRAP ==================
def _proc_running(pattern: str) -> bool:
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
        return r.returncode == 0
    except Exception:
        return False


def start_xvfb():
    """Pastikan Xvfb + openbox jalan di display virtual.

    Aman dipanggil kapan pun: kalau Xvfb belum terinstall, langsung return
    tanpa error (guard pakai shutil.which langsung di dalam fungsi, bukan
    cuma _CUA_DEPS yang dihitung sekali saat module load).
    """
    # Guard kuat: cek binary langsung, biar gak crash walau _CUA_DEPS basi
    if not shutil.which("Xvfb"):
        print("[cua_driver] Xvfb belum terinstall — skip start_xvfb()", file=sys.stderr)
        return
    if not _CUA_DEPS["ok"]:
        return

    if not _proc_running(rf"Xvfb\s+{CUA_DISPLAY}"):
        log = open(LOGS_DIR / "xvfb.log", "a")
        subprocess.Popen(
            ["Xvfb", CUA_DISPLAY, "-screen", "0", CUA_SCREEN, "-nolisten", "tcp"],
            stdout=log, stderr=log, env=ENV,
        )
        time.sleep(1.5)
    if not _proc_running(r"openbox"):
        log = open(LOGS_DIR / "openbox.log", "a")
        subprocess.Popen(["openbox"], stdout=log, stderr=log, env=ENV)
        time.sleep(0.8)


def _xdo(*args, timeout=15):
    """Jalankan xdotool dengan DISPLAY virtual."""
    start_xvfb()
    if not shutil.which("xdotool"):
        return {"rc": -1, "out": "", "err": "xdotool tidak terinstall"}
    try:
        r = subprocess.run(
            ["xdotool"] + list(args),
            capture_output=True, text=True, timeout=timeout, env=ENV,
        )
        return {"rc": r.returncode, "out": r.stdout.strip()[:2000], "err": r.stderr.strip()[:1000]}
    except subprocess.TimeoutExpired:
        return {"rc": -1, "out": "", "err": f"xdotool timeout {timeout}s"}
    except Exception as e:
        return {"rc": -1, "out": "", "err": str(e)}


# ================== MATA (SCREENSHOT) ==================
def screenshot(prefix="shot"):
    """Ambil screenshot layar virtual -> simpan file + base64."""
    start_xvfb()
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = SHOTS_DIR / f"{prefix}_{ts}.png"

    scrot_bin = shutil.which("scrot")
    import_bin = shutil.which("import")

    if not scrot_bin and not import_bin:
        return {"ok": False, "error": "gak ada scrot & import (ImageMagick) — install dulu", "path": str(path)}

    r = subprocess.run(
        [scrot_bin or "scrot", "-o", str(path)],
        capture_output=True, text=True, timeout=20, env=ENV,
    )
    if r.returncode != 0 or not path.exists():
        # fallback: ImageMagick import
        if import_bin:
            r2 = subprocess.run(
                [import_bin, "-window", "root", str(path)],
                capture_output=True, text=True, timeout=25, env=ENV,
            )
        if not path.exists():
            return {"ok": False, "error": f"scrot gagal: {r.stderr[:300]}", "path": str(path)}
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    # bersihin screenshot lama (max 12 file)
    for old in sorted(SHOTS_DIR.glob("shot_*.png"))[:-12]:
        try:
            old.unlink()
        except Exception:
            pass
    return {
        "ok": True,
        "path": str(path),
        "bytes": path.stat().st_size,
        "width": int(CUA_SCREEN.split("x")[0]),
        "height": int(CUA_SCREEN.split("x")[1].split("x")[0]),
        "base64": b64,
    }


# ================== TANGAN (AKSI) ==================
def click(x, y, button=1):
    return _xdo("mousemove", "--sync", str(int(x)), str(int(y)), "click", str(int(button)))


def dblclick(x, y):
    return _xdo("mousemove", "--sync", str(int(x)), str(int(y)), "click", "--repeat", "2", "1")


def rightclick(x, y):
    return click(x, y, 3)


def move(x, y):
    return _xdo("mousemove", "--sync", str(int(x)), str(int(y)))


def drag(x1, y1, x2, y2, button=1, duration=0.3):
    dur = max(float(duration), 0.05)
    return _xdo(
        "mousemove", "--sync", str(int(x1)), str(int(y1)),
        "mousedown", str(int(button)),
        "mousemove", "--sync", "--duration", str(dur), str(int(x2)), str(int(y2)),
        "mouseup", str(int(button)),
    )


def type_text(text):
    """Ketik teks (multi-line aman pakai file temp)."""
    if not text:
        return _xdo("key", "Return")
    text = str(text)
    segs = text.split("\n")
    last = None
    for i, seg in enumerate(segs):
        if i > 0:
            _xdo("key", "Return")
        if seg:
            f = Path("/tmp/cua_type.txt")
            f.write_text(seg, encoding="utf-8")
            last = _xdo("type", "--clearmodifiers", "--delay", "10", "--file", str(f))
            try:
                f.unlink()
            except Exception:
                pass
    return last or {"rc": 0, "out": "", "err": ""}


def key(keys):
    """Tekan tombol/hotkey. Contoh: 'ctrl+c', 'Return', 'alt+Tab'."""
    # bersihin spasi & normalisasi
    keys = str(keys).replace(" ", "")
    if keys.lower() in ("enter", "return"):
        return _xdo("key", "Return")
    return _xdo("key", keys)


def scroll(dx=0, dy=1, times=1):
    """Scroll. dy>0 = turun (wheel down), dy<0 = naik. dx untuk horizontal."""
    n = max(1, min(int(times), 20))
    clicks = []
    if dy:
        btn = "5" if dy > 0 else "4"
        clicks += [btn] * n
    if dx:
        btn = "7" if dx > 0 else "6"
        clicks += [btn] * n
    if not clicks:
        return {"rc": 0, "out": "", "err": "no scroll"}
    return _xdo("click", *clicks)


def status():
    start_xvfb()
    geo = _xdo("getdisplaygeometry")
    active = _xdo("getactivewindow", "getwindowname")
    wm = _xdo("search", "--onlyvisible", "--name", ".*", "getwindowname")
    # list jendela aktif
    wins = []
    try:
        ids = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", ".*"],
            capture_output=True, text=True, env=ENV, timeout=10,
        )
        for wid in ids.stdout.split():
            nm = subprocess.run(
                ["xdotool", "getwindowname", wid],
                capture_output=True, text=True, env=ENV, timeout=5,
            )
            wins.append({"id": wid, "name": nm.stdout.strip()[:120]})
    except Exception:
        pass
    return {
        "display": CUA_DISPLAY,
        "screen": CUA_SCREEN,
        "geometry": geo,
        "deps": _CUA_DEPS,
        "windows": wins[:10],
    }


def open_url(url):
    """Buka URL di browser dalam display virtual (kalau ada browser)."""
    start_xvfb()
    for br in ("chromium-browser", "chromium", "google-chrome", "firefox", "epiphany"):
        p = Path("/usr/bin") / br
        if p.exists():
            subprocess.Popen([str(p), "--no-sandbox", "--new-window", str(url)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)
            time.sleep(1.5)
            return {"ok": True, "browser": br, "url": str(url)}
    return {"ok": False, "error": "ga ada browser (instal chromium/firefox dulu)"}


def launch(cmd):
    """Luncurkan program apa pun di layar virtual (misal app testing)."""
    start_xvfb()
    try:
        subprocess.Popen(str(cmd), shell=True, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, env=ENV)
        return {"ok": True, "cmd": cmd}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ================== DISPATCHER ==================
def run(action: str, body: dict):
    """Dispatcher dipanggil endpoint /api/cua."""
    action = str(action or "").lower()

    # Guard: kalau deps belum lengkap, kasih pesan jelas
    if not _CUA_DEPS["ok"]:
        return {"ok": False,
                "error": f"CUA deps belum lengkap: {', '.join(_CUA_DEPS['missing'])}. "
                         f"Jalankan: pkg install x11-repo && pkg install {' '.join(_CUA_DEPS['missing'])}"}

    start_xvfb()

    if action == "status":
        return {"ok": True, "result": status()}

    if action == "screenshot":
        return {"ok": True, "result": screenshot()}

    if action == "open":
        res = open_url(str(body.get("url", "")).strip())
        return {"ok": res.get("ok", False), "result": res}

    if action == "launch":
        res = launch(str(body.get("cmd", "")).strip())
        return {"ok": res.get("ok", False), "result": res}

    if action == "click":
        return {"ok": True, "result": click(body.get("x", 0), body.get("y", 0), body.get("button", 1))}

    if action == "dblclick":
        return {"ok": True, "result": dblclick(body.get("x", 0), body.get("y", 0))}

    if action == "rightclick":
        return {"ok": True, "result": rightclick(body.get("x", 0), body.get("y", 0))}

    if action == "move":
        return {"ok": True, "result": move(body.get("x", 0), body.get("y", 0))}

    if action == "drag":
        return {"ok": True, "result": drag(
            body.get("x1", 0), body.get("y1", 0),
            body.get("x2", 0), body.get("y2", 0),
            body.get("button", 1), body.get("duration", 0.3))}

    if action == "type":
        return {"ok": True, "result": type_text(body.get("text", ""))}

    if action == "key":
        return {"ok": True, "result": key(body.get("key", "Return"))}

    if action == "scroll":
        return {"ok": True, "result": scroll(
            body.get("dx", 0), body.get("dy", 1), body.get("times", 1))}

    if action == "meta":
        # info layar + screenshot mini (untuk model vision)
        st = status()
        return {"ok": True, "result": {"status": st, "shot": screenshot()}}

    return {"ok": False, "error": f"action '{action}' gak dikenal. Pilihan: status, screenshot, open, launch, click, dblclick, rightclick, move, drag, type, key, scroll, meta"}


if __name__ == "__main__":
    # CLI test:  python3 cua_driver.py screenshot
    a = sys.argv[1] if len(sys.argv) > 1 else "status"
    r = run(a, {})
    if a == "screenshot":
        print("path:", r["result"]["path"], "| bytes:", r["result"]["bytes"])
    else:
        print(r)
