---
name: github-device-flow-auth
description: "Headless GitHub OAuth device flow when gh login hangs."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [github, auth, oauth, device-flow, headless, gh-cli]
    category: github
---

# GitHub OAuth Device-Flow Auth (headless)

## When to use

- `gh auth login` hangs or ignores injected input (submit "y"/Enter does nothing) in background PTY / non-TTY sessions — go-survey interactive prompts are unreliable to drive programmatically.
- You want durable GitHub auth (device flow returns a `refresh_token` that gh auto-refreshes — no classic-PAT expiry management).
- Headless/SSH server where a browser flow must be handed off to the user on another device.

The pattern is RFC 8628 device flow and generalizes to any OAuth provider; GitHub-specific endpoints are verified below.

## Workflow

1. **Get the OAuth client ID** for the GitHub CLI app:
   ```bash
   strings /usr/bin/gh 2>/dev/null | grep -xE '[0-9a-f]{20}' | head -5
   ```
   Debian's `gh` 2.46 is stripped → empty. Fall back to the well-known public GitHub CLI OAuth app client ID: `178c6fc778ccc68e1d6a` (the same ID gh ships with; verified working).

2. **Request a device code** (scopes: `repo workflow` for push + Actions; add `read:org` if needed):
   ```bash
   CID="178c6fc778ccc68e1d6a"
   curl -sS -X POST https://github.com/login/device/code \
     -d "client_id=$CID" -d "scope=repo workflow"
   # → device_code=...&expires_in=899&interval=5&user_code=F061-A1C7&verification_uri=https://github.com/login/device
   ```
   Verified: returns HTTP 200 with a real device/user code.

3. **Hand the `user_code` to the user** — they open `https://github.com/login/device`, type the code, click Authorize. ~15-min window (`expires_in`). This step always requires the user; the agent cannot authorize for them.

4. **Poll until authorized** (interval from response, +5s backoff on `slow_down`):
   ```bash
   curl -sS -X POST https://github.com/login/oauth/access_token \
     -d "client_id=$CID" -d "device_code=$DEVICE_CODE" \
     -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
   ```
   Success → `access_token=...&refresh_token=...&expires_in=...&scope=...`; pending → `authorization_pending`; denied → `access_denied`; expired → `expired_token`. Poll in a background loop writing the result to a file; parse with `sed 's/&/\n/g'`.

5. **Finish setup** — either:
   - gh present: `echo "$ACCESS_TOKEN" | gh auth login --with-token && gh auth setup-git`
   - git-only: write `https://<user>:<token>@github.com` into `~/.git-credentials` (chmod 600) + `git config --global credential.helper store` (see bundled `github-auth` skill for the full credential-store pattern).

## Pitfalls

- **Do NOT try to drive `gh auth login` interactively** via background-PTY stdin injection — the survey prompts ignore it and the process hangs forever. Kill it and use `--with-token` or this device flow instead.
- Interactive `gh auth login --web` in a non-TTY may also fail to print the one-time code at all — the manual curl flow gives you full control of the user_code.
- Device flow codes expire (~15 min) — start polling immediately and tell the user to authorize promptly.
- `slow_down` responses mean you polled too fast — increase interval by 5s each time, never reset it.
- The refresh_token is the durable half: gh persists it and auto-refreshes, so this path beats classic PAT expiry.
- Keep the token out of chat/logs: write straight to credential files, never echo.

## Consolidation note

The bundled `github-auth` skill (protected, cannot be patched from a background curator pass) is the natural long-term home for this technique. If `hermes curator adopt github-auth` is run, fold this skill's content into its "Method 2: gh CLI Authentication" section and delete this one.
