# DEBSISTEN Android App — Debugging & Build Patterns

## Project Context
Kotlin + Jetpack Compose app with AccessibilityService-based computer use automation. Three tabs: Chat (AI + markdown), Providers (API config), Skills (5 toggles). Built via GitHub Actions CI.

---

## Build Failures & Fixes (This Session)

### 1. GitHub Actions — No visible "e: file" errors
**Symptom**: Build fails but `gh api .../logs | grep "e: file"` returns nothing.
**Cause**: Kotlin compiler errors may be in different format; full log needed.
**Fix**: Download full log and search broadly:
```bash
gh run view <id> --repo <owner>/<repo> --log-failed > full.log
grep -i "error\|fail\|unresolved" full.log
```

### 2. `GLOBAL_ACTION_PASTE` doesn't exist in Android API
**Symptom**: `e: Unresolved reference: GLOBAL_ACTION_PASTE`
**Root cause**: Android AccessibilityService only has BACK, HOME, RECENTS, etc. No global paste action.
**Fix**: Use clipboard + paste simulation:
```kotlin
val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
clipboard.primaryClip = ClipData.newPlainText("label", text)
// Then simulate paste via KEYCODE_V + KEYCODE_CTRL or performPaste()
```

### 3. `Color.copy(alpha=...)` doesn't exist
**Symptom**: `e: Unresolved reference: copy` on `Color` (Int)
**Root cause**: `Color` is an `Int` type alias, no `.copy()` method.
**Fix**: Use `ColorUtils.blendARGB(primary, surface, alpha)` or `ColorUtils.setAlphaComponent(color, alpha)`:
```kotlin
import androidx.core.graphics.ColorUtils
val colorWithAlpha = ColorUtils.blendARGB(primaryColor, surfaceColor, 0.1f)
```

### 4. `cancelChildren` missing import
**Symptom**: `e: Unresolved reference: cancelChildren`
**Fix**: Add import:
```kotlin
import kotlinx.coroutines.cancelChildren
```

### 5. Gson `fromJson` type inference fails
**Symptom**: Type mismatch or "Cannot infer type" on `gson.fromJson(json, type)`
**Fix**: Explicit type token:
```kotlin
val mapType = object : TypeToken<Map<String, Any>>() {}.type
val map = gson.fromJson<Map<String, Any>>(json, mapType)
```

### 6. `val clipboard` reassignment error
**Symptom**: `e: Val cannot be reassigned` on `clipboard.primaryClip = clip`
**Root cause**: Property assignment on a `val` reference looks like reassignment to Kotlin.
**Fix**: Use `setPrimaryClip()` method explicitly:
```kotlin
val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
clipboard.setPrimaryClip(ClipData.newPlainText("label", text))
```

### 7. `ArrayAdapter.clear()` crash on read-only list
**Symptom**: `java.lang.UnsupportedOperationException: Operation is not supported for read-only collection` at `ArrayAdapter.clear()`
**Root cause**: `listOf()` creates immutable list; `ArrayAdapter` tries to clear it.
**Fix**: Use `mutableListOf()`:
```kotlin
val models = if (isEdit) provider.models.toMutableList() else mutableListOf<String>()
```

### 8. Gradle cache issues in CI
**Symptom**: Build fails with stale cached artifacts despite code fixes.
**Fix**: Add clean step in workflow:
```yaml
- name: Clean Gradle cache
  run: ./gradlew clean
```

### 9. Missing provider dialog fields
**Issue**: "Tambah Provider" dialog only had API Key + Model + Model Dropdown — no Provider Name, Provider Type, Base URL.
**Fix**: Added fields with auto-fill:
- **Provider Type** dropdown (CUSTOM, GEMINI, OPENROUTER, GROQ, ZAI, DEEPSEEK, TOGETHER, HYPERBOLIC, SILICONFLOW)
- **Base URL** auto-filled on type selection
- **Model** dropdown populated based on provider type
- Validation for all required fields

### 10. Markdown rendering without external deps
**Issue**: Markwon library not on Maven Central; JitPack requires auth.
**Fix**: Custom lightweight markdown parser with `CodeBlockView` component:
- Parse ` ```language\ncode\n``` ` blocks
- Render as custom view with copy button
- Inline code with monospace background
- Basic bold/italic/headers

### 11. AiRouter with provider fallback
**Pattern**: Loop through enabled providers on 429/402/quota errors:
```kotlin
var provider = providerManager.getCurrentProvider()
var attempts = 0
while (provider != null && attempts < maxAttempts) {
    val result = callProvider(provider, text, imageUri)
    when (result) {
        is AiResult.Error -> {
            if (isQuotaError(result.message)) {
                provider = providerManager.getNextProvider(provider)
                attempts++
                continue
            }
        }
    }
}
```

### 12. OpenRouter image base64 support
**Pattern**: Multipart content for vision models:
```kotlin
val userContent = listOf(
    mapOf("type" to "text", "text" to text),
    mapOf("type" to "image_url", "image_url" to mapOf("url" to "data:image/jpeg;base64,$base64Image"))
)
```

### 13. File logging utility (AppLogger)
**File**: `app/src/main/java/com/debsisten/util/AppLogger.kt`
- Writes to `debsisten_logs.txt` in Documents directory
- Dual output: logcat + file
- Levels: d/i/w/e with throwable support
- Call `AppLogger.init(context)` in Application/Activity

---

## CI Debugging Loop (Reproducible)

```bash
# 1. Push fix
git add -A && git commit -m "fix: ..." && git push origin main

# 2. Trigger (or wait for auto-trigger)
gh workflow run "Build DEBSISTEN APK" --repo debzroot/debsisten --ref main

# 3. Watch with exit status
gh run watch <id> --repo debzroot/debsisten --exit-status --interval 12

# 4. On failure, get full log
gh run view <id> --repo debzroot/debsisten --log-failed > build.log
grep -n -i "error\|fail\|unresolved\|cannot" build.log | head -30
```

---

## Key Files Modified This Session
- `app/src/main/java/com/debsisten/service/ComputerUseService.kt` — clipboard paste, type actions
- `app/src/main/java/com/debsisten/service/SpeechService.kt` — cancelChildren import
- `app/src/main/java/com/debsisten/ui/skills/SkillAdapter.kt` — ColorUtils.blendARGB
- `app/src/main/java/com/debsisten/manager/AiClient.kt` — Gson type casts, logging, provider fallback, image base64
- `app/src/main/java/com/debsisten/data/Provider.kt` — default providers, apiKey fix
- `app/src/main/java/com/debsisten/ui/providers/ProvidersFragment.kt` — full provider dialog
- `app/src/main/res/layout/dialog_provider_edit.xml` — new dialog layout
- `app/src/main/java/com/debsisten/ui/home/ChatAdapter.kt` — markdown + code blocks
- `app/src/main/java/com/debsisten/ui/home/CodeBlockView.kt` — code block component
- `app/src/main/java/com/debsisten/util/AppLogger.kt` — file logging
- `.github/workflows/build.yml` — clean step, conditional release

---

## Provider Configuration Quick Reference

| Provider Type | Base URL | Example Models |
|--------------|----------|----------------|
| GEMINI | https://generativelanguage.googleapis.com/v1beta | gemini-2.5-flash-lite, gemini-2.5-pro |
| OPENROUTER | https://openrouter.ai/api/v1 | deepseek-v3, qwen3-235b, llama-4, gpt-4o, claude-3.5-sonnet |
| GROQ | https://api.groq.com/openai/v1 | llama-3.3-70b-versatile, mixtral-8x7b, gemma2-9b-it |
| CUSTOM | https://api.openai.com/v1 (editable) | gpt-4o-mini, gpt-4o |

---

## Common Pitfalls to Avoid
1. **Never use `listOf()` for ArrayAdapter data** — always `mutableListOf()` or `.toMutableList()`
2. **Don't assume property assignment on `val` works** — use setter methods (`setPrimaryClip()`, etc.)
3. **Kotlin compiler errors in CI may not show with `grep "e: file"`** — download full log
4. **Gradle cache can hide fixes** — always `./gradlew clean` in CI
5. **External libraries not on Maven Central need JitPack + auth** — prefer standard library solutions
6. **Provider dialog must validate Base URL + Model + API Key** — all three required
7. **Image base64 for OpenRouter must use `data:image/jpeg;base64,` prefix** — not raw base64