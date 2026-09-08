---
name: github-headless-device-auth
description: "Headless GitHub auth via OAuth device flow (no TTY)."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [github, auth, device-flow, oauth, headless, gh-cli]
    category: github
---

# GitHub Headless Auth via OAuth Device Flow

## When to Use
- Server/container/CI with NO TTY and no browser needs GitHub auth that does NOT expire (classic PATs expire and must be rotated manually).
- The gh CLI interactive `gh auth login --web` can't be driven from a background PTY; use the raw device flow below and register the resulting token with gh.

## Flow (verified working end-to-end)
1. Get a device code (client_id is the PUBLIC GitHub CLI OAuth app, from cli/cli source — not a secret):
   `curl -sS -X POST https://github.com/login/device/code -d "client_id=178c6fc778ccc68e1d6a" -d "scope=repo workflow read:org"`
   → device_code, user_code (e.g. F061-A1C7), verification_uri=https://github.com/login/device, expires_in≈899, interval≈5.
   NOTE: include **read:org** — gh refuses tokens without it ("error validating token: missing required scope 'read:org'").
2. Tell the USER to open the verification URI, enter the user_code, and Authorize (15-min window).
3. Poll in a background loop: POST https://github.com/login/oauth/access_token with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
   Handle: `authorization_pending` → keep polling at `interval`; `slow_down` → +5s; `access_denied` / `expired_token` → abort. Success = `access_token=...&scope=...` (scopes URL-encoded, comma-separated).
4. Register with gh: `echo "$TOKEN" | gh auth login --hostname github.com --git-protocol https --with-token`
5. Wire git: `gh auth setup-git` → sets per-host helpers `credential.https://github.com.helper !/usr/bin/gh auth git-credential` (this is what auto-refreshes the OAuth token).
6. Cleanup stale PAT setup: `git config --global --unset credential.helper` (if it was `store`) and `rm -f ~/.git-credentials` (plaintext token file no longer needed).
7. Verify: `gh auth status`; then `GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote https://github.com/<user>/<repo>.git HEAD` → prints a hash without prompting = done.

## Notes / Pitfalls
- gh stores the OAuth + refresh token in `~/.config/gh/hosts.yml`; with `gh auth setup-git`, git auto-refreshes — no manual token rotation. Only `gh auth logout` or manual revocation kills it.
- Token scopes check: `curl -sSI -H "Authorization: token $TOKEN" https://api.github.com/user` → read the `x-oauth-scopes` header.
- Never echo tokens into chat; pipe/file them into commands only.
- For plain PAT / SSH / interactive gh setups, see the bundled `github-auth` skill — this one covers the headless device-flow path it lacks.
