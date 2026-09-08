#!/usr/bin/env python3

import os
import json
import re
import secrets
import sys
import subprocess
import requests
import uuid
import shutil as _shutil
import sqlite3 as _sqlite3
from pathlib import Path
from typing import Optional

from flask_cors import CORS
from flask import Flask, request, jsonify
from flask_sock import Sock

app = Flask("c0n73xt-tool-server")
CORS(app)
sock = Sock(app)

CONFIG_FILE = Path(__file__).resolve().parent / ".ai-config.ini"

def load_token() -> str:
    try:
        for line in CONFIG_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith("AI_TOOLS_TOKEN") and "=" in line:
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""

TOKEN = os.environ.get("TOOLS_TOKEN", "") or load_token()

if not TOKEN:
    print("[tool-server] FATAL: AI_TOOLS_TOKEN kosong di .ai-config.ini", file=sys.stderr)
    sys.exit(1)

def check_token(supplied: str) -> bool:
    return bool(supplied) and secrets.compare_digest(supplied, TOKEN)

DANGER_PATTERNS = [
    r"\brm\s+(-[a-z]*r[a-z]*f?|--recursive)\b",
    r"\brm\s+[^|;&]*\s/\S*",
    r"\b(dd|mkfs(\.\w+)?|fdisk|parted|wipefs)\b",
    r"\b(shutdown|reboot|halt|poweroff|init\s+[06])\b",
    r"\bchmod\s+-R\s+777\s+/\b",
    r"\bchown\s+-R\b.*\s/\b",
    r"\bmv\s+[^|;&]*\s/\s*$",
    r">\s*/dev/sd[a-z]",
    r"\biptables\b.*-F", r"\bnft\b.*flush",
    r"curl[^|]*\|\s*(ba)?sh",
    r"wget[^|]*\|\s*(ba)?sh",
]
DANGER_RE = [re.compile(p, re.IGNORECASE) for p in DANGER_PATTERNS]

def is_dangerous(command: str) -> Optional[str]:
    for i, rx in enumerate(DANGER_RE):
        m = rx.search(command)
        if m:
            return f"match rule #{i + 1}: {m.group(0)!r}"
    return None


@app.get("/api/health")
def health():
    return jsonify({"status": "healthy", "service": "c0n73xt-tool-server", "version": "2.0-flask"})

def _auth() -> Optional[tuple]:
    body = {}
    try:
        body = request.get_json(silent=True) or {}
    except Exception:
        pass
    supplied = (
        (body.get("token") if isinstance(body, dict) else None)
        or request.headers.get("x-tools-token")
        or request.args.get("token")
        or ""
    )
    if not check_token(str(supplied)):
        return jsonify({"error": "invalid token"}), 403
    return None


@app.post("/api/exec")
def api_exec():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    command = str(body.get("command", "")).strip()
    cwd = str(body.get("cwd", "")).strip() or os.getcwd()
    timeout = min(int(body.get("timeout", 60) or 60), 600)
    approved = bool(body.get("approved", False))

    if not command:
        return jsonify({"error": "command kosong"}), 400
    if not os.path.isdir(cwd):
        return jsonify({"error": f"cwd gak ada: {cwd}"}), 400

    why = is_dangerous(command)
    if why and not approved:
        return jsonify(
            {"need_approval": True, "command": command, "reason": why}
        ), 202

    try:
        res = subprocess.run(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            timeout=timeout,
            env={**os.environ, "TERM": "xterm-256color"}
        )
        return jsonify({
            "stdout": res.stdout.decode("utf-8", errors="replace")[:65536],
            "stderr": res.stderr.decode("utf-8", errors="replace")[:16384],
            "exit_code": res.returncode,
            "command": command,
        })
    except subprocess.TimeoutExpired as e:
        return jsonify({
            "stdout": (e.stdout.decode("utf-8", errors="replace")[:65536] if e.stdout else ""),
            "stderr": f"timeout {timeout}s — proses dibunuh",
            "exit_code": -1
        }), 200
    except Exception as e:
        return jsonify({"stdout": "", "stderr": str(e), "exit_code": -1}), 200


@app.post("/api/fs_read")
def api_fs_read():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    path = str(body.get("path", "")).strip()
    if not path or not os.path.isfile(path):
        return jsonify({"error": f"file gak ada: {path}"}), 404
    if os.path.getsize(path) > 2 * 1024 * 1024:
        return jsonify({"error": "file gede banget (>2MB), pake exec + head/tail"}), 413
    try:
        text = Path(path).read_text(errors="replace")
        return jsonify({"path": path, "content": text, "bytes": len(text)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/fs_write")
def api_fs_write():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    path = str(body.get("path", "")).strip()
    content = str(body.get("content", ""))
    append = bool(body.get("append", False))
    if not path:
        return jsonify({"error": "path kosong"}), 400
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if append:
            with open(p, "a", encoding="utf-8") as f:
                f.write(content)
        else:
            p.write_text(content, encoding="utf-8")
        return jsonify({"path": path, "bytes_written": len(content), "append": append})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/fs_list")
def api_fs_list():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    path = str(body.get("path", "/").strip() or "/")
    if not os.path.isdir(path):
        return jsonify({"error": f"folder gak ada: {path}"}), 404
    try:
        items = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    st = entry.stat()
                    items.append({
                        "name": entry.name,
                        "dir": entry.is_dir(),
                        "size": st.st_size if not entry.is_dir() else None,
                    })
                except Exception:
                    continue
        items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        return jsonify({"path": path, "total_count": len(items), "entries": items[:2000]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/fs_search")
def api_fs_search():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    path = str(body.get("path", "/root/ChatUX").strip() or "/root/ChatUX")
    pattern = str(body.get("pattern", "")).strip()
    in_content = bool(body.get("content", False))
    if not pattern:
        return jsonify({"error": "pattern kosong"}), 400
    if not os.path.isdir(path):
        return jsonify({"error": f"folder gak ada: {path}"}), 404

    try:
        rx_name = re.compile(pattern, re.IGNORECASE)
    except re.error:
        rx_name = re.compile(re.escape(pattern), re.IGNORECASE)

    SKIP_DIRS = {".git", "node_modules", "__pycache__", "ble.sh", ".cache", "proc", "sys"}
    results = []
    LIMIT = 300
    try:
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if len(results) >= LIMIT:
                    return jsonify({"path": path, "pattern": pattern, "truncated": True, "results": results})
                fpath = os.path.join(root, name)
                if rx_name.search(name):
                    results.append({"path": fpath, "match": "name"})
                    continue
                if in_content:
                    try:
                        if os.path.getsize(fpath) > 512 * 1024:
                            continue
                        with open(fpath, "r", errors="ignore") as f:
                            text = f.read()
                        m = rx_name.search(text)
                        if m:
                            results.append({"path": fpath, "match": "content"})
                    except Exception:
                        continue
        return jsonify({"path": path, "pattern": pattern, "truncated": False, "results": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/http")
def api_http():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    url = str(body.get("url", "")).strip()
    method = str(body.get("method", "GET")).upper()[:8]
    headers = body.get("headers") or {}
    data = body.get("body")
    timeout = min(max(int(body.get("timeout", 20) or 20), 1), 60)
    follow = bool(body.get("follow", True))
    if not url:
        return jsonify({"error": "url kosong"}), 400
    if not url.lower().startswith(("http://", "https://")):
        return jsonify({"error": "url harus http(s)://"}), 400
    cmd = ["curl", "-s", "-S", "-m", str(timeout), "-X", method, "-o", "-", "-w", "\n%{http_code}"]
    if follow:
        cmd.insert(1, "-L")
    for k, v in (headers or {}).items():
        cmd += ["-H", "{k}: {v}".format(k=k, v=v)]
    if data is not None:
        cmd += ["--data", str(data)]
        if method == "GET":
            cmd[cmd.index("-X") + 1] = "POST"
    cmd.append(url)
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 10)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "http timeout", "http_code": "408", "body": "", "bytes": 0}), 200
    except Exception as e:
        return jsonify({"error": str(e), "http_code": "000", "body": "", "bytes": 0}), 200
    raw = res.stdout.decode("utf-8", errors="replace")
    parts = raw.rsplit("\n", 1)
    code = parts[1].strip() if len(parts) > 1 else "000"
    txt = parts[0] if len(parts) > 1 else raw
    truncated = False
    if len(txt) > 262144:
        txt = txt[:262144] + "\n...[truncated]"
        truncated = True
    err = res.stderr.decode("utf-8", errors="replace").strip()
    eff = method if (data is None or method != "GET") else "POST"
    return jsonify({
        "url": url, "method": eff, "http_code": code,
        "body": txt, "bytes": len(txt), "truncated": truncated,
        "curl_error": (err[:2000] or None),
    }), 200


@app.post("/api/download")
def api_download():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    url = str(body.get("url", "")).strip()
    path = str(body.get("path", "")).strip()
    timeout = min(max(int(body.get("timeout", 120) or 120), 5), 600)
    max_mb = int(body.get("max_mb", 200) or 200)
    if not url or not path:
        return jsonify({"error": "url & path wajib"}), 400
    if not url.lower().startswith(("http://", "https://")):
        return jsonify({"error": "url harus http(s)://"}), 400
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.is_dir():
            return jsonify({"error": "path adalah folder, kasih nama file"}), 400
        cmd = ["curl", "-s", "-S", "-L", "-f", "--max-filesize", str(max_mb * 1024 * 1024),
               "-m", str(timeout), "-o", str(p), "-w", "%{http_code}", url]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 15)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "download timeout"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    code = res.stdout.decode("utf-8", errors="replace").strip() or "000"
    err = res.stderr.decode("utf-8", errors="replace").strip()
    bytes_saved = p.stat().st_size if p.exists() else 0
    out = {"path": str(p), "http_code": code, "bytes": bytes_saved}
    if err:
        out["error"] = err[:2000]
    return jsonify(out), 200


@app.post("/api/db")
def api_db():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    db_path = str(body.get("db_path", "")).strip()
    sql = str(body.get("sql", "")).strip()
    params = body.get("params") or []
    row_limit = min(max(int(body.get("limit", 500) or 500), 1), 5000)
    if not db_path:
        return jsonify({"error": "db_path kosong"}), 400
    if not sql:
        return jsonify({"error": "sql kosong"}), 400
    try:
        conn = _sqlite3.connect(db_path, timeout=5)
        conn.row_factory = _sqlite3.Row
        cur = conn.cursor()
        if isinstance(params, dict):
            cur.execute(sql, params)
        elif isinstance(params, list):
            cur.execute(sql, params)
        else:
            cur.execute(sql)
        low = sql.strip().lower()
        if low.startswith(("select", "pragma", "explain", "with", "show")):
            rows = cur.fetchmany(row_limit)
            cols = [d[0] for d in (cur.description or [])]
            data = [dict(zip(cols, r)) if cols else None for r in rows]
            conn.close()
            return jsonify({"columns": cols, "rows": data, "count": len(data), "truncated": len(data) >= row_limit}), 200
        conn.commit()
        affected = cur.rowcount
        lastrow = cur.lastrowid
        conn.close()
        return jsonify({"affected": affected, "lastrowid": lastrow, "ok": True}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500


@app.post("/api/archive")
def api_archive():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    action = str(body.get("action", "")).lower()
    archive_path = str(body.get("archive_path", "")).strip()
    target_dir = str(body.get("target_dir", "")).strip()
    if action not in ("create", "extract"):
        return jsonify({"error": "action harus create/extract"}), 400
    if not archive_path:
        return jsonify({"error": "archive_path kosong"}), 400
    try:
        if action == "extract":
            if not os.path.isfile(archive_path):
                return jsonify({"error": "file arsip gak ada: " + archive_path}), 404
            dest = target_dir or os.path.dirname(archive_path) or "."
            os.makedirs(dest, exist_ok=True)
            if archive_path.endswith((".zip", ".apk")):
                import zipfile
                with zipfile.ZipFile(archive_path) as z:
                    infos = z.infolist()
                    z.extractall(dest)
                return jsonify({"action": "extract", "format": "zip", "entries": len(infos), "dest": dest}), 200
            import tarfile
            with tarfile.open(archive_path) as t:
                members = t.getmembers()
                t.extractall(dest)
            return jsonify({"action": "extract", "format": "tar", "entries": len(members), "dest": dest}), 200
        files = body.get("files") or []
        if not isinstance(files, list) or not files:
            return jsonify({"error": "files (list path) wajib buat create"}), 400
        base_dir = str(body.get("base_dir", "")).strip() or None
        os.makedirs(os.path.dirname(archive_path) or ".", exist_ok=True)
        if archive_path.endswith(".zip"):
            import zipfile
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as z:
                for f in files:
                    f = str(f)
                    if not os.path.exists(f):
                        continue
                    arc = os.path.relpath(f, base_dir) if base_dir else os.path.basename(f)
                    z.write(f, arc)
            return jsonify({"action": "create", "format": "zip", "archive": archive_path}), 200
        import tarfile
        mode = "w:gz" if archive_path.endswith((".tar.gz", ".tgz")) else ("w:bz2" if archive_path.endswith(".tar.bz2") else "w")
        with tarfile.open(archive_path, mode) as t:
            for f in files:
                f = str(f)
                if not os.path.exists(f):
                    continue
                arc = os.path.relpath(f, base_dir) if base_dir else os.path.basename(f)
                t.add(f, arcname=arc)
        fmt = "tar" + ("-gz" if archive_path.endswith((".tar.gz", ".tgz")) else ("-bz2" if archive_path.endswith(".tar.bz2") else ""))
        return jsonify({"action": "create", "format": fmt, "archive": archive_path}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/ps")
def api_ps():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    pattern = str(body.get("pattern", "")).strip()
    try:
        res = subprocess.run(["ps", "-e", "-o", "pid,user,args"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if res.returncode != 0:
            res = subprocess.run(["ps", "aux"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        text = res.stdout.decode("utf-8", errors="replace")
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    lines = text.splitlines()
    if not lines:
        return jsonify({"processes": [], "total": 0}), 200
    header = lines[0]
    procs = []
    for line in lines[1:]:
        cols = line.split(None, 2)
        if len(cols) < 2:
            continue
        pid, user = cols[0], cols[1]
        cmd = cols[2] if len(cols) > 2 else ""
        if pattern and pattern.lower() not in (cmd + " " + pid).lower():
            continue
        procs.append({"pid": pid, "user": user, "cmd": cmd[:300]})
    return jsonify({"processes": procs, "total": len(procs), "header": header}), 200


@app.post("/api/kill")
def api_kill():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    pid = body.get("pid")
    pattern = str(body.get("pattern", "")).strip()
    sig = int(body.get("signal", 15) or 15)
    if sig not in (1, 2, 9, 15):
        return jsonify({"error": "signal harus 1/2/9/15"}), 400
    self_pid = os.getpid()
    targets = []
    if pid is not None:
        pid = int(pid)
        if pid <= 1 or pid == self_pid:
            return jsonify({"error": "gak boleh kill proses penting itu"}), 400
        targets = [str(pid)]
    elif pattern:
        try:
            res = subprocess.run(["ps", "-e", "-o", "pid,args"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            text = res.stdout.decode("utf-8", errors="replace") if res.returncode == 0 else ""
        except Exception:
            text = ""
        for line in text.splitlines()[1:]:
            cols = line.split(None, 1)
            if len(cols) < 2:
                continue
            p, cmd = cols[0], cols[1]
            if pattern.lower() in cmd.lower() and p not in ("1", str(self_pid)):
                targets.append(p)
    else:
        return jsonify({"error": "kasih pid atau pattern"}), 400
    results = []
    for p in targets:
        try:
            os.kill(int(p), sig)
            results.append({"pid": p, "ok": True, "signal": sig})
        except Exception as e:
            results.append({"pid": p, "ok": False, "error": str(e)})
    return jsonify({"killed": results, "signal": sig}), 200


_NOTES_DB = str(Path(__file__).resolve().parent / "notes.db")

def _notes_conn():
    conn = _sqlite3.connect(_NOTES_DB, timeout=5)
    conn.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, content TEXT, updated_at TEXT DEFAULT (datetime('now')))")
    conn.commit()
    return conn


@app.post("/api/note")
def api_note():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    action = str(body.get("action", "list")).lower()
    key = str(body.get("key", "")).strip()
    content = str(body.get("content", ""))
    pattern = str(body.get("pattern", "")).strip()
    try:
        conn = _notes_conn()
        if action == "add":
            if not key:
                conn.close()
                return jsonify({"error": "key wajib"}), 400
            conn.execute("INSERT INTO notes (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content=excluded.content, updated_at=datetime('now')", (key, content))
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "key": key, "bytes": len(content)}), 200
        if action == "get":
            cur = conn.execute("SELECT key, content, updated_at FROM notes WHERE key=?", (key,))
            row = cur.fetchone()
            conn.close()
            if not row:
                return jsonify({"error": "note tidak ada: " + key}), 404
            return jsonify({"key": row[0], "content": row[1], "updated_at": row[2]}), 200
        if action == "delete":
            cur = conn.execute("DELETE FROM notes WHERE key=?", (key,))
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "deleted": cur.rowcount}), 200
        if action == "search":
            cur = conn.execute("SELECT key, content, updated_at FROM notes WHERE key LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 20", (f"%{pattern}%", f"%{pattern}%"))
            rows = cur.fetchall()
            conn.close()
            return jsonify({"results": [{"key": r[0], "content": r[1][:500], "updated_at": r[2]} for r in rows], "count": len(rows)}), 200
        cur = conn.execute("SELECT key, length(content) AS len, updated_at FROM notes ORDER BY updated_at DESC LIMIT 100")
        rows = cur.fetchall()
        conn.close()
        return jsonify({"notes": [{"key": r[0], "bytes": r[1], "updated_at": r[2]} for r in rows], "count": len(rows)}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500


def _pkg_mgr():
    for m in ("apk", "pkg", "apt-get", "apt"):
        p = _shutil.which(m)
        if p:
            return m, p
    return None, None


@app.post("/api/pkg")
def api_pkg():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    action = str(body.get("action", "search")).lower()
    package = str(body.get("package", "")).strip()
    timeout = 120 if action in ("install", "remove", "update") else 30
    mgr, mgr_path = _pkg_mgr()
    if not mgr:
        return jsonify({"error": "gak ada package manager (apk/pkg) di sistem ini"}), 501
    if mgr == "apk":
        cmds = {
            "search": ["apk", "search", package],
            "install": ["apk", "add", package],
            "remove": ["apk", "del", package],
            "update": ["apk", "update"],
            "installed": ["apk", "info"],
        }.get(action, ["apk", "info"])
    else:
        cmds = {
            "search": [mgr, "search", package],
            "install": [mgr, "install", "-y", package],
            "remove": [mgr, "remove", "-y", package],
            "update": [mgr, "update"],
            "installed": [mgr, "list", "--installed"],
        }.get(action, [mgr, "list", "--installed"])
    if action in ("search", "install", "remove") and not package:
        return jsonify({"error": "package wajib"}), 400
    try:
        res = subprocess.run(cmds, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env={**os.environ, "TERM": "dumb"})
    except subprocess.TimeoutExpired:
        return jsonify({"error": action + " timeout " + str(timeout) + "s"}), 504
    out = res.stdout.decode("utf-8", errors="replace")
    err = res.stderr.decode("utf-8", errors="replace")
    return jsonify({"mgr": mgr, "action": action, "package": package, "exit_code": res.returncode,
                    "stdout": out[:8192], "stderr": err[:4096]}), 200


_CUA_AVAILABLE = False
_cua = None
_cua_error_msg = "" 

try:
    import cua_driver as _cua
    _cua.start_xvfb()
    _CUA_AVAILABLE = True
except Exception as e:
    _cua_error_msg = str(e)
    print(f"[tool-server] CUA disabled: {e}", file=sys.stderr)


@app.post("/api/cua")
def api_cua():
    deny = _auth()
    if deny:
        return deny
    if not _CUA_AVAILABLE:
        return jsonify({
            "ok": False,
            "error": f"CUA belum aktif — {_cua_error_msg}. Pastikan Xvfb, openbox, xdotool terinstall."
        }), 200
    body = request.get_json(silent=True) or {}
    action = str(body.get("action", "")).strip()
    try:
        res = _cua.run(action, body)
        return jsonify({"ok": res.get("ok", False), "action": action, "result": res.get("result") or res.get("error")}), 200
    except Exception as e:
        return jsonify({"ok": False, "action": action, "error": str(e)}), 200


@app.route("/api/screenshot", methods=["GET", "POST"])
def api_screenshot():
    deny = _auth()
    if deny:
        return deny
    if not _CUA_AVAILABLE:
        return jsonify({"ok": False, "error": "CUA belum aktif — install deps dulu"}), 500
    try:
        shot = _cua.screenshot()
        if not shot.get("ok"):
            return jsonify({"ok": False, "error": shot.get("error")}), 500
        return jsonify({"ok": True, "path": shot["path"], "width": shot["width"],
                        "height": shot["height"], "base64": shot["base64"]}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


_BROWSER_SHOT_DIR = str(Path(__file__).resolve().parent / "screenshots")

@app.post("/api/browser")
def api_browser():
    deny = _auth()
    if deny:
        return deny
    body = request.get_json(silent=True) or {}
    command = str(body.get("command", "")).strip()
    VALID = {"goto", "content", "text", "title", "screenshot", "click", "type", "press", "wait", "eval", "close"}
    if not command:
        return jsonify({"error": "command kosong: " + "|".join(sorted(VALID))}), 400
    if command not in VALID:
        return jsonify({"error": f"command tidak dikenal: {command}"}), 400

    args = [command]
    if command == "goto":
        url = str(body.get("url", "")).strip()
        if not url.startswith(("http://", "https://", "file://")):
            return jsonify({"error": "url harus http(s):// atau file://"}), 400
        args.append(url)
    elif command == "screenshot":
        p = str(body.get("path", "")).strip() or (_BROWSER_SHOT_DIR + "/browser_shot.png")
        args.append(p)
    elif command in ("click", "type"):
        sel = str(body.get("selector", "")).strip()
        if not sel:
            return jsonify({"error": "selector wajib untuk click/type"}), 400
        args.append(sel)
        if command == "click":
            args.append(str(int(body.get("index", 0) or 0)))
        else:
            args.append(str(body.get("text", "")))
    elif command == "press":
        args.append(str(body.get("key", "Enter")))
    elif command == "wait":
        args.append(str(int(body.get("ms", 1000) or 1000)))
    elif command == "eval":
        js = str(body.get("js", "")).strip()
        if not js:
            return jsonify({"error": "js wajib untuk eval"}), 400
        args.append(js)

    try:
        res = subprocess.run(
            ["python3", str(Path(__file__).resolve().parent / "browser.py"), *args],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=130,
        )
        stdout = res.stdout.decode("utf-8", errors="replace")
        stderr = res.stderr.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "command": command, "error": "browser timeout 130s"}), 200
    except Exception as e:
        return jsonify({"ok": False, "command": command, "error": str(e)}), 200

    data = {}
    try:
        data = json.loads(stdout) if stdout.strip() else {}
    except Exception:
        data = {"ok": False, "error": (stdout or stderr)[:2000]}

    if command == "screenshot" and data.get("ok"):
        path = data.get("path") or (args[1] if len(args) > 1 else "")
        if path and os.path.isfile(path):
            try:
                from PIL import Image
                import io as _io
                import base64 as _b64
                img = Image.open(path)
                img.thumbnail((1024, 1024))
                buf = _io.BytesIO()
                img.save(buf, "JPEG", quality=80)
                data["base64"] = "data:image/jpeg;base64," + _b64.b64encode(buf.getvalue()).decode()
                data["width"], data["height"] = img.size
            except Exception as e:
                data.setdefault("warn", f"base64 gagal: {e}")

    if not data.get("ok") and stderr:
        data.setdefault("error", stderr[:2000])
    data.setdefault("command", command)
    return jsonify(data), 200


@sock.route("/ws/terminal/<terminal_id>")
def terminal_websocket(ws, terminal_id):
    token = request.args.get("token", "")
    if not check_token(token):
        ws.close()
        return
    
    ws.send("\033[32m✓ c0n73xt tool-server terminal connected\033[0m\n")
    ws.send("\033[90mKetik command shell. /help buat bantuan.\033[0m\n\n")
    
    history = []
    try:
        while True:
            data = ws.receive(timeout=None)
            if data is None:
                break
            if data == "PING":
                ws.send("PONG")
                continue
            if data.strip() == "/help":
                ws.send(
                    "\033[36m═══ c0n73xt terminal ═══\033[0m\n"
                    "  /clear /pwd /cd DIR /exit — sisanya shell langsung\n"
                )
                continue
            if data.strip() == "/clear":
                ws.send("\033c")
                continue
            if data.strip() == "/pwd":
                ws.send(f"{os.getcwd()}\n")
                continue
            if data.strip().startswith("/cd "):
                target = data.strip()[4:].strip()
                try:
                    os.chdir(target)
                    ws.send(f"\033[32mcd: {os.getcwd()}\033[0m\n")
                except Exception as e:
                    ws.send(f"\033[31mcd: {e}\033[0m\n")
                continue
            if data.strip() == "/exit":
                ws.close()
                break

            command = data.strip()
            if not command:
                continue
            history.append(command)
            cwd = os.getcwd()
            ws.send(f"\033[90m$ {command}\033[0m\n")
            try:
                p = subprocess.Popen(
                    command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=cwd,
                    env={**os.environ, "TERM": "xterm-256color"}
                )
                for line in iter(p.stdout.readline, b''):
                    ws.send(line.decode("utf-8", errors="replace"))
                for line in iter(p.stderr.readline, b''):
                    ws.send(f"\033[31m{line.decode('utf-8', errors='replace')}\033[0m")
                p.wait()
                if p.returncode != 0:
                    ws.send(f"\033[90m[exit: {p.returncode}]\033[0m\n")
            except Exception as e:
                ws.send(f"\033[31m[error: {e}]\033[0m\n")
    except Exception:
        pass


@app.route("/", methods=["GET", "POST", "OPTIONS"])
def root_handler():
    if request.method == "OPTIONS":
        return jsonify({"ok": True}), 200

    action = request.args.get("action")
    if action == "providers":
        body = request.get_json(silent=True) or {}
        
        if body.get("op") == "gensession":
            base_url = body.get("base_url")
            api_key = body.get("api_key")
            ua = body.get("ua")
            
            if not base_url:
                return jsonify({"success": False, "error": "Base URL kosong"}), 400
                
            try:
                headers = {"User-Agent": ua} if ua else {}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                    
                resp = requests.get(base_url, headers=headers, timeout=10)
                
                session_id = resp.headers.get("X-Session-ID") or resp.headers.get("Set-Cookie")
                
                if session_id:
                    return jsonify({"success": True, "session_id": session_id, "source": "response"})
                else:
                    return jsonify({"success": True, "session_id": str(uuid.uuid4()), "source": "generated"})
                    
            except Exception as e:
                return jsonify({"success": False, "error": f"Gagal fetch target: {str(e)}"}), 500
                
    return jsonify({"error": "Not Found"}), 404


if __name__ == "__main__":
    _port = int(os.getenv("TOOLS_PORT", os.getenv("BACKEND_PORT", 9090)))
    if _port < 1024:
        print(f"[tool-server] Port {_port} < 1024, naikkan ke 9090 (Termux non-root)", file=sys.stderr)
        _port = 9090
    print(f"[tool-server] Starting on port {_port}...", file=sys.stderr)
    app.run(host="0.0.0.0", port=_port)
