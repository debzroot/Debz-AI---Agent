# Discord REST API verification recipes (bot token auth)

All calls: `curl -sS --max-time 15 -H "Authorization: Bot <TOKEN>" https://discord.com/api/v10/<endpoint>`
(HTTP 401 = bad token). The bot token comes from the Discord Developer Portal → Bot → Reset Token.

## 1. Verify token + get the BOT's identity

```
curl -sS -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me
```

Response includes `"id":"...","username":"...","bot":true`. Remember this id — it is the
BOT's id and must NEVER appear in DISCORD_ALLOWED_USERS (see pitfall 1 in SKILL.md).

## 2. Is the bot in any server yet?

```
curl -sS -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me/guilds
```

- `[]` → bot invited nowhere → it cannot DM anyone yet (expect 50007 below). Send the
  invite URL: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=274878286912`
- Non-empty → bot is in guilds; each entry has `id` (guild id) and `name`.

## 3. Is a claimed user ID a human or a bot?

```
curl -sS -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/<ID>
```

- Human: `{"id":...,"username":...,"global_name":...}` — NO `bot` field.
- Bot: includes `"bot":true`.
Always run this on the user's "user id" before trusting the allowlist.

## 4. Open a DM channel (and send a test message)

```
# Step A — create the DM channel (must share a guild OR user must have messaged bot first)
curl -sS -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipient_id":"<USER_ID>"}' https://discord.com/api/v10/users/@me/channels
# -> {"id":"<CHANNEL_ID>",...} on success; 50007 on failure (see below)

# Step B — send a message into that channel
curl -sS -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"hello"}' https://discord.com/api/v10/channels/<CHANNEL_ID>/messages
```

Note: creating the channel takes `{"recipient_id": ...}` — posting `{"content": ...}` to
`/users/@me/channels` gives 50035 `CHANNEL_RECIPIENT_REQUIRED` (wrong shape, not an auth error).

## Error codes seen in practice

| Code | Meaning | Action |
|---|---|---|
| 401 Unauthorized | Bad/revoked token | Re-issue token in Developer Portal |
| 50007 Cannot send messages to this user | No shared guild, or user never messaged the bot | Invite bot to server; user DMs bot once |
| 50035 Invalid Form Body / CHANNEL_RECIPIENT_REQUIRED | Wrong body shape for channel creation | Use `recipient_id`, not `content` |

## Gateway-side checks (cross-reference with API results)

`~/.hermes/logs/gateway.log`:
- Healthy connect: `[Discord] Connected as NAME#ID` then `✓ discord connected`.
- User message processed: `inbound message: platform=discord user=<name> ... msg='...'`
  then `response ready: ... response=<N> chars` then `Sending response (<N> chars)`.
- Bot "online but never replies" + NO `inbound message:` lines for the user's messages =
  allowlist problem (DISCORD_ALLOWED_USERS) or missing Message Content Intent — check both.
- Slash commands auto-sync: `[Discord] Registered /skill command with N skill(s) via autocomplete`
  and `Safely reconciled N slash command(s)` — expected on startup.
