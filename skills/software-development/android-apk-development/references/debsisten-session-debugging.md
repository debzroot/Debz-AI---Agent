# DEBSISTEN Session Debugging Notes (August 2026)

## Session Summary
Built and fixed DEBSISTEN APK — 3-tab AI assistant app (Chat / Providers / Skills) with multi-provider fallback, root skills, STT/TTS, AccessibilityService. Fixed 20+ compilation errors, 3 GitHub Actions build failures, and critical runtime bugs.

---

## Critical Bugs Fixed

### 1. Provider API Key Corrupted (`***` instead of `String`)
**File**: `app/src/main/java/com/debsisten/data/Provider.kt`
**Symptom**: User enters API key in UI → saves → reads back empty → all API calls 401
**Root cause**: Editor/encoding issue replaced `String` type with `***` 
**Fix**: Restore `var apiKey: String = ""`
**Prevention**: Clean build after data model changes; lint for `***` in .kt files

### 2. Dropdown Value Ignored in Provider Dialog
**File**: `app/src/main/java/com/debsisten/ui/providers/ProvidersFragment.kt`
**Symptom**: User selects model from AutoCompleteTextView dropdown → saves → model empty
**Root cause**: Code only read manual `etModel` EditText, ignored `actvModel` dropdown
**Fix**: Read both, dropdown takes priority:
```kotlin
val modelFromDropdown = dialogBinding.actvModel.text.toString().trim()
val modelFromInput = dialogBinding.etModel.text.toString().trim()
val model = modelFromDropdown.ifEmpty { modelFromInput }
```

### 3. Silent API Failures (No UI Error)
**Symptom**: Chat sends → spinner → nothing, no toast, no error bubble
**Root causes**:
- Empty API key (bug #1) → 401 but no error surfaced
- `AiClient` catches exceptions but `HomeFragment` callback didn't implement `onError`
**Fix**: Complete error callback chain:
```kotlin
// HomeFragment
val callback = object : AiClient.AiCallback {
    override fun onError(error: String) {
        Toast.makeText(requireContext(), "Error: $error", Toast.LENGTH_LONG).show()
    }
}
```
**Lesson**: Always surface raw error text in UI for remote debugging.

---

## Build System Fixes

### GitHub Actions Stale Code / Cache
**Symptom**: Fixes pushed but CI shows old errors
**Fixes**:
- `actions/checkout@v4` with `clean: true`
- Add `./gradlew clean` step before assemble
- Trigger with explicit ref: `gh workflow run "Build" --repo owner/repo --ref main`
- Verify commit SHA: `gh run list --repo owner/repo --limit 5 --json headSha`

### Conditional Release Build
**Problem**: `assembleRelease` fails when keystore secrets not configured
**Fix**: Conditional steps with `if: env.KEYSTORE_PATH != '' && ...`
- Debug builds on every push
- Release only when secrets present

---

## Provider Dialog UX (Final)

### Fields
| Field | Auto-fill | Required |
|-------|-----------|----------|
| Nama Provider | — | No (defaults to type) |
| Tipe Provider (dropdown) | — | Yes |
| Base URL / Endpoint | ✓ By type | Yes |
| API Key | — | Yes |
| Model (manual + dropdown) | ✓ By type | Yes |
| Aktifkan (switch) | ON | — |

### Default Providers Loaded
1. **Opencode Free** — `https://opencode.ai/api/v1` — model: `opencode-free`
2. **Google Gemini** — `https://generativelanguage.googleapis.com/v1beta` — models: `gemini-2.5-flash-lite`, `gemini-2.5-pro`
3. **OpenRouter** — `https://openrouter.ai/api/v1` — models: `deepseek-v3`, `qwen3-235b`, `llama-4`, `gpt-4o`, `gpt-4o-mini`, `claude-3.5-sonnet`
4. **Custom** — `https://api.openai.com/v1` — models: `gpt-4o-mini`, `gpt-4o`

### Test Connection
Validates all 3 required fields (API Key, Model, Base URL) before test call.

---

## Debug Logging (AppLogger)

**Utility**: `com.debsisten.util.AppLogger` — writes to `files/logs.txt` in app sandbox
```kotlin
AppLogger.i("AiClient", "sendMessage called")
AppLogger.e("HomeFragment", "AI error", e)
```

**Retrieve logs**:
```bash
adb shell run-as com.debsisten cat files/logs.txt
```

---

## Key Commands Used

```bash
# Build & CI
gh workflow run "Build DEBSISTEN APK" --repo debzroot/debsisten --ref main
gh run watch <id> --repo debzroot/debsisten --exit-status
gh run list --repo debzroot/debsisten --limit 5
gh api repos/debzroot/debsisten/actions/jobs/<job-id>/logs

# Local fixes
cd /tmp/debsisten
git add -A && git commit -m "fix: ..." && git push origin main

# ADB debugging
adb logcat | grep -i debsisten
adb shell run-as com.debsisten cat files/logs.txt
```

---

## Lessons for Future AI Assistant Apps

1. **Data model integrity**: Corrupted field types (`***`) cause silent failures. Clean build + lint.
2. **Dialog dual-input**: AutoCompleteTextView + EditText for same field — always read both.
3. **Error visibility**: Complete callback chain from network → orchestrator → UI. Toast every error.
4. **File logging**: AppLogger → `logs.txt` → ADB pull. Essential for remote chat debugging.
5. **CI cleanliness**: `./gradlew clean` in workflow prevents stale cache ghosts.
6. **Provider fallback**: Test with invalid keys first to verify 429/401 handling works.