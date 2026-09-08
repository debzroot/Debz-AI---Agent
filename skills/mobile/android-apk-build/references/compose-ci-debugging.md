# Kotlin/Compose CI debugging — patterns from real failures

## Context
Debugging a Jetpack Compose Android app (`SshProfile.kt`/`MainScreen.kt`) built via GitHub Actions on a headless runner. The build loop used this cycle repeatedly:

1. Push → `gh run list --repo debzroot/debsshplus --limit 1` (grab run id)
2. `gh run watch <id> --repo ... --exit-status --interval 12` (watch progress)
3. On failure: `gh run view <id> --repo ... --log-failed 2>&1 | grep -E "e: |error:|FAILURE" | head -15`
4. Fix locally, commit, push (auto-triggers new run — no manual re-trigger)

## Error 1: trailing-lambda binds to wrong parameter

### Symptom
```
MainScreen.kt:230:21 No value passed for parameter '<no name provided>'
MainScreen.kt:230:41 Unresolved reference: it
```

### Root cause
The custom composable was declared as:
```kotlin
private fun NeoField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    isPassword: Boolean = false,
    height: Dp = 50.dp
)
```
Called as:
```kotlin
NeoField("Host / IP", host) { host = it }
```
Kotlin binds the **trailing lambda** to the **last parameter whose type is a function type**. Because `onChange` is *not* the last parameter (isPassword, height follow), the lambda `{ host = it }` is offered to `height` (a `Dp`) → "inferred type is () -> Unit but Dp was expected", `onChange` is left without a value → "No value passed for parameter '<no name provided>'"`, and the lambda body never receives an `it` → "Unresolved reference: it".

### Fix
Use named arguments so the lambda binds to `onChange` explicitly:
```kotlin
NeoField(
    label = "Host / IP",
    value = host,
    onChange = { host = it }
)
```
With the signature fixed to put `onChange` last, trailing lambdas also work, but named args are robust against future signature reordering.

## Error 2: internal `Modifier.weight`

### Symptom
```
MainScreen.kt:15:43 Cannot access 'weight': it is internal in 'androidx.compose.foundation.layout'
MainScreen.kt:619:14 Expression 'weight' cannot be invoked as a function
```

### Root cause
In recent Compose versions `weight` (the `Modifier.weight` extension) is **internal** — it cannot be imported or called directly. It is exposed as a member only within `RowScope`/`ColumnScope` receiver scopes.

### Fix
- Remove `import androidx.compose.foundation.layout.weight`.
- Either: call `.weight(...)` inside a `Row {}`/`Column {}` lambda (where the scope provides it), or replace with explicit layout (`fillMaxWidth()` + `horizontalArrangement`/`Arrangement.spacedBy`).
- In this session, `TemplateChip` used `.weight(1f)` in a `Column` inside a `Row`. Removed the weight and let the parent `Row` handle spacing.

## Error 3: regex-rename double-hit a function definition

### Symptom
A Python regex intended to rename call sites `NeoField(...)` also rewrote the **function definition** signature line into something invalid:
```
private fun NeoField(
    label = label: String,
    value = value: String,
    value = onChange: (String) -> Unit,
    ...
```
producing `Parameter name expected` / `No value passed for parameter '<no name provided>'` errors. Separately, a naive substring replacement turned `NeoField` → `NeoNeoField` at three call sites.

### Fix
- Never run a blanket regex over identifiers that appear in both call sites and the definition.
- Anchor rewrites on the call-site shape `NeoField( ... ) { ... }` and guard the definition line, or rename the function with a refactor tool.
- After any bulk rename, grep for the function name to confirm exactly one definition + N call sites and no doubled prefixes.

## Notes
- `clip`, `weight`, `fillMaxWidth`, `height` in `Modifier` chains are all `androidx.compose.foundation.layout.*` — scope rules matter.
- Always `git add -A && git commit` after fixes so the pushed commit reflects the corrected file before the CI run.
