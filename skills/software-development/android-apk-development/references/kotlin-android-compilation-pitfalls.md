# Kotlin/Android Compilation Pitfalls & Fixes (August 2026 Session)

Collected during the DEBSISTEN APK build session fixing 20+ compilation errors across Kotlin files.

---

## 1. Gson Type Inference in `when` Expressions

**Error**: `Not enough information to infer type argument for 'T'` on `gson.fromJson(json, mapType)`

**Cause**: When `gson.fromJson()` is called inside a `when` branch, Kotlin can't infer the generic type `T` because the branch isn't typed.

**Fix**: Add explicit cast or type witness:
```kotlin
@Suppress("UNCHECKED_CAST")
val args = gson.fromJson(json, mapType) as Map<String, Any>
// OR
val args = gson.fromJson<Map<String, Any>>(json, mapType)
```

---

## 2. `val` vs `var` — Misleading Error Message

**Error**: `'val' cannot be reassigned` at line `clipboard.primaryClip = clip`

**Root cause**: The variable was declared `val clipboard = ...` but the error points to the property setter call. In Kotlin, `val` means the *reference* is immutable, not the object. Setting a property (`clipboard.primaryClip = ...`) on a `val` **is allowed**. The real issue was a stale build cache — the runner had old code.

**Fix**: Change to `var` to silence the compiler (or force clean build):
```kotlin
var clipboard = getSystemService(...) as ClipboardManager
```

---

## 3. `AccessibilityService.GLOBAL_ACTION_PASTE` Doesn't Exist

**Error**: `Unresolved reference 'GLOBAL_ACTION_PASTE'`

**Fact**: Android's `AccessibilityService` only defines: `GLOBAL_ACTION_BACK`, `GLOBAL_ACTION_HOME`, `GLOBAL_ACTION_RECENTS`, `GLOBAL_ACTION_NOTIFICATIONS`, `GLOBAL_ACTION_QUICK_SETTINGS`, `GLOBAL_ACTION_POWER_DIALOG`, `GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN`. No `PASTE`.

**Workaround**: Use root keyevent via `su`:
```kotlin
Runtime.getRuntime().exec("su -c input keyevent 279").waitFor()  // KEYCODE_PASTE = 279
```

---

## 4. `Color.copy()` Method Doesn't Exist

**Error**: `Unresolved reference 'copy'` on `Color.copy(alpha = 0.1f)`

**Fix**: Use `ColorUtils.blendARGB()` from `androidx.core.graphics`:
```kotlin
import androidx.core.graphics.ColorUtils

val color = ColorUtils.blendARGB(primaryColor, surfaceColor, 0.1f)
```

---

## 5. Gson Overload Resolution Ambiguity

**Error**: `Overload resolution ambiguity between candidates: fun <T> fromJson(String, Type), fun <T> fromJson(Reader, Type), ...`

**Cause**: `gson.fromJson(jsonString, TypeToken<...>().type)` — Kotlin can't pick the String overload when `jsonString` type isn't explicitly `String`.

**Fix**: Ensure the first arg is explicitly `String` or add type witness:
```kotlin
val result: MyType = gson.fromJson(jsonString as String, typeToken.type)
```

---

## 6. Duplicate Class Declarations Across Files

**Error**: `Redeclaration: class AiResult` / `Conflicting declarations: var promptTokens`

**Cause**: Created `ResponseParser.kt` with `sealed class AiResult`, `data class ToolCallResult`, `data class UsageResult`, `object ResponseParser` — but these **already existed in `ApiModels.kt`**.

**Fix**: Delete the duplicate file; import from the original:
```kotlin
import com.debsisten.network.AiResult
import com.debsisten.network.ToolCallResult
import com.debsisten.network.UsageResult
import com.debsisten.network.ResponseParser
```

---

## 7. RecyclerView ViewHolder Must Be `inner class`

**Error**: `Class '<anonymous>' is not abstract and does not implement abstract member 'onToolCall'` / `Unresolved reference 'onClick'`

**Cause**: ViewHolder defined as `class ViewHolder(...)` instead of `inner class ViewHolder(...)`. Non-inner classes can't access outer class members.

**Fix**: Add `inner`:
```kotlin
inner class ProviderViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView)
```

---

## 8. Missing `Binder` Import for Service

**Error**: `Unresolved reference 'Binder'` in `SpeechService` / `TtsService`

**Fix**: Explicit import:
```kotlin
import android.os.Binder
```

---

## 9. `CoroutineScope.cancel()` Doesn't Exist

**Error**: `Unresolved reference 'cancel'` on `scope.cancel()`

**Fix**: Use `cancelChildren()` extension or coroutineContext:
```kotlin
import kotlinx.coroutines.cancelChildren
scope.coroutineContext.cancelChildren()
// OR
scope.cancelChildren()
```

---

## 10. GitHub Actions Runner Using Stale Code

**Symptom**: Fixes pushed, but `gh run watch` still shows old compilation errors.

**Cause**: GitHub Actions may cache the repository or the workflow wasn't triggered on the latest commit. The `push` trigger runs on the commit that triggered it; `workflow_dispatch` from CLI uses the current `main` HEAD.

**Fixes**:
- Use `gh run watch <run-id> --repo owner/repo --exit-status` to wait for completion
- Trigger with explicit ref: `gh workflow run "Build" --repo owner/repo --ref main`
- Add `actions/checkout@v4` with `fetch-depth: 0` or `clean: true` (default)
- Check `gh run list --repo owner/repo --limit 5` to verify which commit ran

---

## 11. ChatMessage Constructor — Named Params Required for Nullable Fields

**Error**: `No parameter with name 'toolCalls' found` / `Unresolved reference 'toolCalls'`

**Cause**: `ChatMessage` data class has `tool_calls: List<ToolCall>? = null` but calling `ChatMessage("assistant", null, toolCalls = list)` uses positional + named mix incorrectly.

**Fix**: Use all named parameters:
```kotlin
ChatMessage(
    role = "assistant",
    content = null,
    tool_calls = toolCallObjects
)
```

---

## 12. `ChatMessage` Missing `copy()` Method Reference

**Error**: `Unresolved reference 'copy'` on `skill.copy(enabled = isChecked)`

**Cause**: `Skill` is a `@Entity` data class — but Room entities with `var` properties don't generate `copy()` by default if any property is `var` with custom getter/setter or `@PrimaryKey` is non-standard.

**Fix**: Ensure all properties are `val` or explicitly add `copy()`:
```kotlin
@Entity
data class Skill(
    @PrimaryKey val id: String,
    val name: String,
    val description: String,
    var enabled: Boolean = false,  // var breaks copy() in some Room versions
    val category: String = "general"
)
```
If `copy()` is needed, make `enabled` a `val` and use `skill.copy(enabled = newValue)` with a new instance, or add a manual `copy()` function.

---

## 13. Material3 vs MaterialComponents Theme Parents

**Error**: `Widget.Material3.CardView` not found, `Widget.Material3.Chip.Choice` not found

**Fix**: Use MaterialComponents parents for these widgets:
```xml
<!-- CardView -->
<style name="Widget.App.CardView" parent="Widget.MaterialComponents.CardView"/>

<!-- Chip -->
<style name="Widget.App.Chip.Choice" parent="Widget.MaterialComponents.Chip.Choice"/>
```
Material3 doesn't yet provide CardView/Chip styles; MaterialComponents does.

---

## 14. `buildDir` Deprecated in Gradle Kotlin DSL

**Warning**: `buildDir` is deprecated

**Fix**: Use `layout.buildDirectory.get().asFile()`:
```kotlin
tasks.register("clean", Delete::class) {
    delete(layout.buildDirectory.get().asFile())
}
```

---

## 15. AndroidManifest `package` Attribute Deprecated

**Warning**: `package="com.debsisten"` in manifest

**Fix**: Remove `package` from `<manifest>`; set `namespace = "com.debsisten"` in `app/build.gradle.kts`.

---

## 16. `FAIL_ON_PROJECT_REPOS` Conflict

**Error**: `FAIL_ON_PROJECT_REPOS` but repositories defined in root `build.gradle.kts`

**Fix**: Move all repositories to `settings.gradle.kts` under `dependencyResolutionManagement`; remove `allprojects { repositories { ... } }` from root `build.gradle.kts`.

---

## 17. ABI Splits Removed in AGP 8.5+

**Error**: `splits` block deprecated/removed

**Fix**: Remove `splits { abi { ... } }` from `app/build.gradle.kts`. Use alternative (universal APK or App Bundle) instead.

---

## 18. XML Entity Escaping in strings.xml

**Error**: `The entity name must immediately follow the '&' in the entity reference`

**Fix**: Escape `&` as `&amp;`:
```xml
<string name="skill_desc_web">Browse web &amp; ambil konten</string>
```

---

## 19. Missing mipmap/ic_launcher Resources

**Error**: `@mipmap/ic_launcher` not found

**Fix**: Generate adaptive icons + legacy PNGs for all densities:
- `res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`
- `res/mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` (adaptive)
- Use `scripts/gen_icons.py` (see skill scripts)

---

## 20. Accessibility Service Config — Invalid Attribute

**Error**: `canRequestTouchExploration` not valid

**Fix**: Remove from `res/xml/accessibility_service_config.xml` — not a valid attribute for `<accessibility-service>`.

---

## Session-Specific Fixes Applied (DEBSISTEN)

| File | Fix |
|------|-----|
| `AiClient.kt` | Added explicit casts on all `gson.fromJson()` calls in `executeToolCall()`; fixed `ChatMessage` named params |
| `ComputerUseService.kt` | Replaced `GLOBAL_ACTION_PASTE` with `su -c input keyevent 279`; changed `val clipboard` to `var` |
| `SpeechService.kt` | Added `import android.os.Binder`; `scope.coroutineContext.cancelChildren()` |
| `TtsService.kt` | Added `import android.os.Binder` |
| `SkillAdapter.kt` | `inner class SkillViewHolder`; `ColorUtils.blendARGB()` instead of `Color.copy()` |
| `ProviderAdapter.kt` | `inner class ProviderViewHolder` |
| `HomeFragment.kt` | Added `ToolCallResult` import; fixed `sendMessage` coroutine wrapper |
| `ApiModels.kt` | Kept as single source of truth for `AiResult`, `ToolCallResult`, `UsageResult`, `ResponseParser` |
| `build.gradle.kts` (root) | Fixed `clean` task syntax |
| `settings.gradle.kts` | Added `google()`, `mavenCentral()` to `dependencyResolutionManagement` |
| `.github/workflows/build.yml` | `setup-java@v5`, `setup-android@v3` with `packages: "platforms;android-34 build-tools;34.0.0"` |
| `strings.xml` | `&amp;` escape |
| `themes.xml` | MaterialComponents parents for CardView/Chip |

---

## Quick Debug Commands

```bash
# Watch build with exit status
gh run watch <id> --repo debzroot/debsisten --exit-status

# View failed logs
gh run view <id> --repo debzroot/debsisten --log-failed

# List recent runs
gh run list --repo debzroot/debsisten --limit 5

# Trigger build on latest main
gh workflow run "Build DEBSISTEN APK" --repo debzroot/debsisten --ref main

# View job logs directly (if run view truncated)
gh api repos/debzroot/debsisten/actions/jobs/<job-id>/logs
```

---

## 21. `ClipboardManager.primaryClip` Property Setter May Trigger False 'val' Error

**Error**: `'val' cannot be reassigned` on `clipboard.primaryClip = clip` (or `setPrimaryClip()`)

**Observed**: With `val clipboardManager = getSystemService(...) as ClipboardManager`, the compiler reported an error at the property setter line. However, in Kotlin `val` only makes the *reference* immutable — setting a property on the object IS allowed.

**Root cause**: GitHub Actions runner had stale build cache. The fix in local code (`var` → `val` + `setPrimaryClip()`) wasn't reflected on the runner.

**Fixes tried**:
```kotlin
// Option 1: Change to var (silences compiler, but val is correct)
var clipboardManager = getSystemService(...) as ClipboardManager

// Option 2: Use explicit setter method (clearer intent)
clipboardManager.setPrimaryClip(clip)

// Option 3: Force clean build in workflow
- name: Clean Gradle cache
  run: ./gradlew clean
```

**Lesson**: Always add `./gradlew clean` step in GitHub Actions workflow to ensure fresh compilation. The error was misleading — the real issue was stale runner state.

---

## 22. GitHub Actions Runner Stale Code / Cache Issues

**Symptom**: Fixes pushed to `main`, but `gh run watch` shows old compilation errors that were already fixed locally.

**Causes**:
- GitHub Actions may use cached checkout from previous run
- `workflow_dispatch` triggered from CLI uses current `main` HEAD, but if pushed commits haven't propagated yet, it builds old code
- Gradle daemon/cache on runner from previous runs

**Fixes**:
```yaml
# In workflow - force clean checkout and clean build
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # full history
    clean: true     # clean working directory

- name: Clean Gradle cache
  run: ./gradlew clean

# Trigger build with explicit ref
gh workflow run "Build" --repo owner/repo --ref main

# Verify which commit ran
gh run list --repo owner/repo --limit 5 --json headSha,conclusion
```

**Debug**: Check `gh run view <id> --log` → "Checking out the ref" section to see which commit SHA was checked out.

---

## 23. Conditional Release Build When Keystore Secrets Missing

**Problem**: `assembleRelease` fails with `path may not be null or empty string. path=''` when GitHub secrets (`KEYSTORE_PATH`, `KEY_STORE_PASSWORD`, etc.) are not configured.

**Fix**: Conditionally skip release build and related steps:
```yaml
- name: Build Release APK
  if: env.KEYSTORE_PATH != '' && env.KEY_STORE_PASSWORD != '' && env.KEY_ALIAS != '' && env.KEY_PASSWORD != ''
  run: ./gradlew assembleRelease
  env:
    KEYSTORE_PATH: ${{ secrets.KEYSTORE_PATH }}
    KEY_STORE_PASSWORD: ${{ secrets.KEY_STORE_PASSWORD }}
    KEY_ALIAS: ${{ secrets.KEY_ALIAS }}
    KEY_PASSWORD: ${{ secrets.KEY_PASSWORD }}

- name: Upload Release APK
  if: env.KEYSTORE_PATH != '' && env.KEY_STORE_PASSWORD != '' && env.KEY_ALIAS != '' && env.KEY_PASSWORD != ''
  uses: actions/upload-artifact@v4
  ...

- name: Create Release (on tag)
  if: startsWith(github.ref, 'refs/tags/v') && env.KEYSTORE_PATH != '' && ...
```

This allows Debug APK to build successfully on every push while Release only builds when secrets are present.

---

## 24. Data Class Field Corrupted by Editor/Encoding — `var apiKey: *** = ""`

**Error**: Gson deserialization silently fails; API key reads as empty string even after user enters it in UI.

**Observed**: In `Provider.kt`, the field showed:
```kotlin
@SerializedName("apiKey")
var apiKey: *** = "",
```
The `String` type was replaced with `***` (likely editor/IDE masking or encoding issue).

**Impact**: 
- Gson can't deserialize into `***` type → field stays empty
- No compilation error — just runtime silent failure
- `PreferencesManager.getProviders()` returns providers with empty `apiKey`
- All API calls send `Authorization: Bearer ` (empty) → 401 Unauthorized

**Fix**: Restore explicit type:
```kotlin
@SerializedName("apiKey")
var apiKey: String = "",
```

**Prevention**: 
- Run `./gradlew clean assembleDebug` after any data model changes
- Add unit test that serializes/deserializes Provider with API key
- Lint check: grep for `\*\*\*` in .kt files

---

## 25. AutoCompleteTextView / Dropdown Value Ignored in Dialog

**Problem**: User selects model from dropdown (`actvModel`), but saved provider has empty model.

**Root cause**: Dialog code only read from manual input field (`etModel`), ignored dropdown selection:
```kotlin
// BROKEN - only reads manual input
val model = dialogBinding.etModel.text.toString().trim()
```

**Fix**: Read from BOTH, dropdown takes priority:
```kotlin
val modelFromDropdown = dialogBinding.actvModel.text.toString().trim()
val modelFromInput = dialogBinding.etModel.text.toString().trim()
val model = modelFromDropdown.ifEmpty { modelFromInput }
```

**Applies to**: Any dialog with `AutoCompleteTextView` + manual `EditText` for same field. Always check both sources.

---

## 26. Silent API Failures — No User-Visible Error, Just Empty Response

**Symptoms**: 
- Chat sends message, spinner shows, then nothing happens
- No toast, no error message, no response rendered
- Logcat shows 401/400 but UI doesn't surface it

**Root causes in DEBSISTEN**:
1. Empty API key (see #24) → `Authorization: Bearer ` → 401
2. `AiClient.sendMessage` catches all exceptions but only calls `callback.onError()` if not handled upstream
3. `HomeFragment` callback didn't handle `onError` → silent failure

**Fix**: Ensure error callback chain is complete:
```kotlin
// In AiClient.kt
} catch (e: Exception) {
    AppLogger.e("AiClient", "sendMessage error", e)
    withContext(Dispatchers.Main) {
        callback.onError(e.message ?: "Unknown error")
    }
    isProcessing = false
}

// In HomeFragment.kt
val callback = object : AiClient.AiCallback {
    override fun onError(error: String) {
        AppLogger.e("HomeFragment", "AI error: $error")
        binding.etMessage.isEnabled = true
        Toast.makeText(requireContext(), "Error: $error", Toast.LENGTH_LONG).show()
    }
    // ... other methods
}
```

**Lesson**: In chat apps across a remote session, **always surface raw error text in UI** (Toast, Snackbar, or error bubble). Silent failures are un-debuggable when you can't read logcat.

---

## Session-Specific Fixes Applied (DEBSISTEN - August 2026)

| File | Fix |
|------|-----|
| `AiClient.kt` | Added explicit casts on all `gson.fromJson()` calls in `executeToolCall()`; fixed `ChatMessage` named params |
| `ComputerUseService.kt` | Replaced `GLOBAL_ACTION_PASTE` with `su -c input keyevent 279`; changed `val clipboard` to `val clipboardManager` + `setPrimaryClip()` |
| `SpeechService.kt` | Added `import android.os.Binder`; `scope.coroutineContext.cancelChildren()` |
| `TtsService.kt` | Added `import android.os.Binder` |
| `SkillAdapter.kt` | `inner class SkillViewHolder`; `ColorUtils.blendARGB()` instead of `Color.copy()` |
| `ProviderAdapter.kt` | `inner class ProviderViewHolder` |
| `HomeFragment.kt` | Added `ToolCallResult` import; fixed `sendMessage` coroutine wrapper |
| `ApiModels.kt` | Kept as single source of truth for `AiResult`, `ToolCallResult`, `UsageResult`, `ResponseParser` |
| `build.gradle.kts` (root) | Fixed `clean` task syntax |
| `settings.gradle.kts` | Added `google()`, `mavenCentral()` to `dependencyResolutionManagement` |
| `.github/workflows/build.yml` | `setup-java@v5`, `setup-android@v3` with `packages: "platforms;android-34 build-tools;34.0.0"`; conditional release build |
| `strings.xml` | `&amp;` escape |
| `themes.xml` | MaterialComponents parents for CardView/Chip |