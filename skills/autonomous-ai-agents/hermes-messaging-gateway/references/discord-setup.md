# Discord gateway setup detail

Condensed from the official Hermes docs (docs/user-guide/messaging/discord) + verified in practice on a Linux/Android host (Hermes v0.20.0).

## Bot creation (user does this in their browser, ~10 min)

1. https://discord.com/developers/applications → sign in → **New Application** → name it (e.g. "Hermes") → Create.
2. Left sidebar → **Bot** → set **Public Bot = ON**, **Require OAuth2 Code Grant = OFF**.
3. **Privileged Gateway Intents** (the critical step):
   - **Server Members Intent = ON** (resolve usernames for the allowed-users list)
   - **Message Content Intent = ON** (without it the bot connects but message text is EMPTY — the #1 reason Discord bots appear online but never respond)
   - Save Changes. (<100 servers → toggles free; personal use is fine.)
4. **Token**: Bot page → Token section → **Reset Token** (2FA code if enabled) → copy immediately — **shown only once**. Never share/commit; anyone with it controls the bot.
5. **Invite URL**: left sidebar → **Installation** → Installation Contexts: enable **Guild Install**; Install Link: **Discord Provided Link**; Default Install Settings → Scopes: `bot` + `applications.commands`; Permissions: Recommended.
   - Recommended permission integer: **274878286912** (View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Send Messages in Threads, Add Reactions). Minimal: 117760.
   - Manual URL fallback (needed if Public Bot = OFF):
     `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=274878286912`
6. Open the invite URL → pick the server → Authorize (needs **Manage Server** permission on that server; bot shows offline until the gateway runs).
7. **User ID**: Discord → Settings → Advanced → **Developer Mode ON** → right-click own username → **Copy User ID** (long number like 284102345871466496). Developer Mode also exposes Channel/Server IDs the same way.

## Env vars (~/.hermes/.env)

```
DISCORD_BOT_TOKEN=<token>
DISCORD_ALLOWED_USERS=<user_id>            # comma-separated for multiple
# DISCORD_FREE_RESPONSE_CHANNELS=<channel_ids>   # channels that reply WITHOUT @mention
# DISCORD_REQUIRE_MENTION=false                  # disable @mention requirement globally
# DISCORD_IGNORE_NO_MENTION=false                # (default true) stay silent when msg @mentions others but not the bot
```

Config.yaml (non-secret) websocket liveness thresholds: `discord.websocket_liveness_interval_seconds: 15`, `websocket_liveness_failure_threshold: 2`, `websocket_heartbeat_ack_max_age_seconds: 60`, `websocket_max_latency_seconds: 30`.

## Session model (defaults)

- Each DM = its own session. Each server thread = its own session namespace. Each user in a shared channel = own session (`group_sessions_per_user: true`).
- Server channels: responds only when @mentioned unless the channel is in DISCORD_FREE_RESPONSE_CHANNELS or mentions are disabled globally.
- DMs: responds to every message, no mention needed.

## Token verification (before starting the gateway)

```
curl -sS -H "Authorization: Bot <token>" https://discord.com/api/v10/users/@me
```
Valid → JSON with `"id"`, `"username"`, `"bot": true`. 401 → token bad/truncated. The username returned is the bot's own name — a great sanity check that the user pasted the right credential.

## DM delivery rule (verified: error 50007)

A bot CANNOT initiate a DM with a user unless they share a guild or the user has already messaged the bot. API call `POST /users/@me/channels` with `{"recipient_id": ...}` then send → `50007 Cannot send messages to this user` when the rule isn't met. This is expected Discord behavior, NOT a config bug. The test flow is: user sends the bot a DM first, then the bot replies.

## Connection confirmation

`hermes gateway status` shows PID. `~/.hermes/logs/gateway.log` shows:
- `[Discord] Connected as Debz_AI#6674` (adapter login)
- `✓ discord connected` (gateway-level)
- `Gateway running with 1 platform(s)`

A foreground `hermes gateway run` wrapped in `timeout N` logs "Received SIGTERM ... exiting with code 1" — that's the wrapper killing it, not a crash. Use `terminal(background=true)`.
