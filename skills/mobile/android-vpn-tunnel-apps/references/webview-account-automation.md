# WebView Account Automation (FastSSH-style providers)

Goal: generate provider accounts inside an in-app WebView so a real human solves CAPTCHA from their own IP (anti-Cloudflare, legal, no backend). Used by HTTP Injector-class apps.

## RECOMMENDED PATTERN (v2, stable): manual copy, NO JS injection

Auto-detect proved unreliable in practice on FastSSH even with exact-marker + form-filled guards (user reported the WebView "always backs out before the account is made", felt like ghost-touch, page reloads/iframe behavior defeats polling). The pattern the user explicitly requested and that works:

- **WebView = plain browser helper.** `javaScriptEnabled=true` (CAPTCHA needs it), `domStorageEnabled`, mixed content allowed, desktop-ish UA. NO `addJavascriptInterface`, NO polling, NO auto-close.
- **Toolbar with Minimize (🗕) + Close (✕)** buttons, macOS-style traffic-light dots for chrome:
  - Minimize → WebView collapses to a small tap-to-restore bar (`minimized` Compose state); **WebView instance stays alive** (session/cookies preserved) so the user can restore and re-check the result page.
  - Close → `onClose()` tears it down.
- **App-side manual credential fields**: terminal-styled `TextField`s for Username / Password / Host / Port. User copies the four values from the result page and pastes.
- **Separate buttons**: `🌐 Buat Akun` (opens WebView) and `⚡ Konek` (uses the field values; validate non-empty before connecting; error box if missing).
- Minimize/restore must NOT recreate the WebView — hold it in `remember { mutableStateOf<WebView?>(null) }` and keep the same instance across minimize toggles.

This is stable by construction: nothing can auto-fire, no parsing to get wrong, and the user has full control.

## Deep-link to the exact page (on-point UX)

FastSSH serves one account-creator page per server/type; URL pattern observed:
```
https://www.fastssh.com/page/ssh-account-creator-stunnel/server/<serverid>/ssh-stunnel-<country>/
```
Hunt the real URL by grepping the servers page for `href=...ssh-account-creator...`. Build the URL from the selected server so the user never navigates — they land straight on the create form.

## Page anatomy (verified)

- Form: `<input id="user" name="username" maxlength="12" required>`, `<input id="pass" name="password" required>`, hidden `serverid`/`ssid`.
- Submit button: `value="create ssh account"`.
- Success marker text: **"Account Created by FastSSH :"** — appears ONLY after successful submit.
- Result block also contains `Username: ...`, `Password: ...`, `Host: ...`, `Port: ...`, and the real server IP.
- **Host/port only exist in the result page** — static `*.fastssh.com` hostnames are placeholders and are NOT connectable (`UnknownHostException`). Never hardcode; always take host from the generated account.

## Alternative (v1): JS-injection auto-detect — only for stable pages

If the provider page is confirmed stable (no iframes, no reload-on-interaction), polling every ~1.5s can work:

```js
(function(){
  try {
    var body = document.body ? document.body.innerText : '';
    if (body.indexOf('Account Created by FastSSH') !== -1) {
      var user = document.getElementById('user')?.value?.trim() || '';
      var pass = document.getElementById('pass')?.value?.trim() || '';
      var mh = body.match(/Host\s*:\s*([A-Za-z0-9._-]+)/i);
      var mp = body.match(/Port\s*:\s*(\d+)/i);
      if (user && pass && mh) Android.onSuccess(user, pass, mh[1], parseInt(mp ? mp[1] : 22));
    }
  } catch(e) {}
})();
```

### PITFALLS that killed v1 on FastSSH (the "as/as account" bug, then ghost-touch)

- Generic regex `/created|success|account/i` matches the submit button label **"create ssh account"** → fires before submit → fallback regex scrapes random 2-letter substrings ("as") → fake account auto-close. Fix: exact post-submit marker + non-empty user/pass/host.
- Even with strict guards, page reloads/iframe re-renders can make the detector fire early or the WebView feel unstable ("selalu back", ghost-touch). When the user reports this, **switch to the manual-copy pattern** — do not keep tuning the detector.
- `addJavascriptInterface` callbacks arrive on a background thread → `Handler(mainLooper).post { ... }` before touching Compose state.

## Provider-specific facts worth re-verifying each project

- FastSSH also offers UDP / SSL-stunnel / WebSocket / Obfs pages — each has its own account-creator path.
- Alternative free SSH panels exist (sshkit, etc.) — same WebView pattern applies; verify their success-marker text per provider.

## Logs: share as FILE, not text

`Intent.EXTRA_STREAM` + `FileProvider` (`androidx.core.content.FileProvider`, authority `${applicationId}.fileprovider`, `res/xml/file_paths.xml` mapping `files-path` → `logs/`) so the user sends a real `.txt`. Sharing raw `EXTRA_TEXT` produces garbage. Without the `<provider>` block in the manifest, FileProvider fails silently — check manifest first when "share logs does nothing".
