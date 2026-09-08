# Android OpenVPN Embed — Build Error Patterns

## Tool-level pitfall: write_file and large payloads
Writing large files (a single Kotlin file > 5 KB, or a batch of patches in one response) can
trigger a **stream timeout** — the call returns an empty response, and no write happens.

Mitigation:
- Keep each write_file under ~8 K bytes.
- If a single file is larger, **patch it incrementally** (use `old_string` + `new_string`)
  rather than rewriting it wholesale.
- If a batch of patch calls fails silently, resubmit each call individually.

## Common Kotlin compile errors and fixes

### `Conflicting overloads: public open fun setMtu(mtu: Int) defined in DebOpenVpnService`
**Cause:** implementing both `EngineCallback` and `IOpenVPNService` — both declare the same
method names (`setMtu`, `protectFd`, `openTun`). Kotlin can't choose the override.

**Fix:** implement **only one** of the two interfaces. The minimal viable choice is
`EngineCallback`; drop `IOpenVPNService` entirely. (The engine's `IOpenVPNService` param is
fulfilled by an internal anonymous stub in `VpnController.runEngine()` anyway.)

### `Unresolved reference: EngineCallback` / `Unresolved reference: VpnProfile`
**Cause:** `EngineCallback` and `VpnProfile` are defined in the same file as `VpnController`
but the file ended up with a **duplicate declaration** of `VpnController` (the whole object
block was pasted twice — a copy-paste artifact from a large `write_file`).

**Fix:** rewrite the file cleanly with a single `object VpnController { ... }` block.
Detect with `javap` on the AAPT output or `grep "Conflicting declarations"` in the log.

### `Unresolved reference: stopEngine`
**Cause:** `stopEngine()` was defined as a **local function** inside `runEngine()`, making it
inaccessible from other methods (`onDestroy`, `stopVpn`).

**Fix:** define `fun stopEngine()` and `fun maskToPrefix(...)` at the top level of the
`object VpnController` body — they are `object` methods, not locals.

### `e: file:///…:138:27 Expecting ')'` / `Unexpected tokens` after `try { withTimeout(…)`
**Cause:** a missing closing brace of the `launch` block or a mis-braced `catch` block
inside a `scope.launch { … }` coroutine.

**Fix:** wrap the timeout block as:
```kotlin
engineJob = scope.launch {
    engineThread = Thread { ... }
    try {
        withTimeout(20_000) {
            while (engineThread?.isAlive == true) {
                delay(500)
                if (!engineJob?.isActive == true) return@launch
            }
        }
    } catch (e: Exception) { ... }
}
```

### `e: file:///…:138:53 Unresolved reference: it`
**Cause:** lambda had no `it` parameter (e.g., using `{ cfg -> ... }` but referencing `it`).

### `e: file:///… Missing '}'`
**Cause:** a file-level brace imbalance from a duplicated `object` declaration.

## Verification commands
```bash
# Check AAR API surface (what method signatures to implement)
javap -classpath tim06-classes.jar com.tim.openvpn.service.IOpenVPNService | grep "public"
# Check VpnServiceConnection constructor signature
javap -classpath basevpn-classes.jar com.tim.basevpn.connection.VpnServiceConnection | grep -E "public|abstract"
# Check OpenVPNConfigParser source (in sources jar)
find /tmp/tim06-src -name "OpenVPNConfigParser.kt"
```
