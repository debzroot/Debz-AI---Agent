#!/usr/bin/env python3
"""
browser.py — Helper Python untuk browser automation (Playwright + Chromium Alpine).
AI agent boleh panggil via exec:  python3 browser.py <command> [args]

Command sama seperti pw_browser.mjs:
  goto <url> | content | text | title | screenshot <path> | click <sel> [idx] |
  type <sel> <text> | press <key> | wait <ms> | eval <js> | close

Contoh:
  python3 browser.py goto https://example.com
  python3 browser.py text
  python3 browser.py screenshot screenshots/shot.png
"""
import json
import os
import subprocess
import sys

NODE = "/usr/bin/node"
WRAPPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pw_browser.mjs")


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "butuh command",
            "usage": "goto|content|text|title|screenshot|click|type|press|wait|eval|close",
        }))
        return 1

    cmd = sys.argv[1]
    args = sys.argv[2:]
    try:
        proc = subprocess.run(
            [NODE, WRAPPER, cmd, *args],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": "timeout 120s"}))
        return 1

    out = (proc.stdout or "").strip()
    if out:
        try:
            print(json.dumps(json.loads(out), ensure_ascii=False))
        except json.JSONDecodeError:
            print(json.dumps({"ok": True, "raw": out, "stderr": proc.stderr[-500:]}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": proc.stderr[-500:] or "no output"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())