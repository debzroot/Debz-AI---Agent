# AI Assistant App with Root Skills & Multi-Provider Fallback (DEBSISTEN Reference)

## When to Use
Building an Android app that acts as an AI assistant with:
- Multi-provider LLM fallback (8+ free providers, auto-switch on 429/quota)
- Root command execution via `su -c` exposed as function calling/tools
- STT/TTS foreground services for voice I/O
- AccessibilityService for UI automation (Computer Use)
- EncryptedSharedPreferences for API key storage
- Room database for chat history
- 3-tab architecture: Chat / Provider Settings / Skill Toggles

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MainActivity (ViewPager2)                │
├──────────────┬──────────────────────┬──────────────────────┤
│   Home       │    Providers         │     Skills           │
│  (Chat)      │   (Settings)         │   (Toggles)          │
└──────┬───────┴──────────┬───────────┴──────────┬───────────┘
       │                  │                      │
       ▼                  ▼                      ▼
┌─────────────┐    ┌──────────────┐      ┌──────────────┐
│ AiClient    │    │ProviderManager│     │ SkillManager │
│ (orchestrator)  │ (fallback)    │      │ (enabled tools)│
└──────┬──────┘    └──────┬────────┘      └──────┬───────┘
       │                  │                      │
       ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Retrofit + OkHttp (OpenAI/Gemini API)         │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Root Executor: `Runtime.getRuntime().exec("su -c <cmd>")` │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Multi-Provider Fallback (`ProviderManager`)
- Loads 8 default providers (Gemini, OpenRouter, Z.AI, Groq, DeepSeek, Together, Hyperbolic, SiliconFlow) from `getDefaultProviders()`
- Each provider has: `id`, `name`, `baseUrl`, `apiKey`, `model`, `models[]`, `enabled`, `dailyLimit`, `usedToday`
- **Fallback logic**: On 429/quota error → mark provider exhausted → `rotateToNextProvider()` → retry
- `getEnabledProviders()` filters `enabled && canUse()` (checks daily limit)
- Persists to EncryptedSharedPreferences (AES256-GCM) via `PreferencesManager`

### 2. Root Skill Execution (`AiClient.executeToolCall()`)
6 skills exposed as OpenAI/Gemini function declarations:
| Skill | Command | Description |
|-------|---------|-------------|
| executeCommand | `su -c "<cmd>"` | Arbitrary shell with root |
| takeScreenshot | `su -c screencap /sdcard/ss.png` | Screenshot to file |
| controlApp | `input tap/swipe/text/keyevent` | UI automation |
| fileManager | `ls/cat/rm/mkdir/cp/mv` | File ops |
| webBrowse | `OkHttp GET <url>` | Fetch & extract HTML |
| computerUse | AccessibilityService gestures | UI automation via a11y |

**Function calling flow**:
1. AI returns `tool_calls` → `AiClient` executes each via `executeToolCall()`
2. Results sent back to provider as `tool` role messages
3. Provider returns final response

### 3. STT Service (`SpeechService`)
- `SpeechRecognizer` in foreground service (microphone type)
- `RecognitionListener` callbacks → `onResults()` → deliver text to UI
- Hold-to-talk: start service on `ACTION_DOWN`, stop on `ACTION_UP`
- Language: `id-ID` (configurable)

### 4. TTS Service (`TtsService`)
- `TextToSpeech` in foreground service
- `UtteranceProgressListener` for completion tracking
- Auto-speak after AI response (configurable)

### 5. Computer Use (`ComputerUseService`)
- `AccessibilityService` with `dispatchGesture()` for tap/swipe
- Clipboard + paste for text input (API 24+)
- Screenshot via root `screencap`
- Queue-based action processing

### 6. Data Layer
- **Room Database**: `ChatMessage` (id, role, content, timestamp, imageUri, providerId, model, toolCalls, toolResults), `Provider`, `Skill`
- **EncryptedSharedPreferences**: API keys, settings (autoTTS, language, theme)
- **TypeConverters** for List<String> ↔ JSON

## Manifest Essentials
```xml
<!-- Root -->
<uses-permission android:name="android.permission.ACCESS_SUPERUSER" tools:ignore="ProtectedPermissions"/>
<uses-permission android:name="android.permission.WRITE_SECURE_SETTINGS" tools:ignore="ProtectedPermissions"/>

<!-- Services -->
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>

<!-- Storage -->
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage"/>

<!-- Accessibility -->
<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE"/>

<!-- Services in application -->
<service android:name=".service.SpeechService" android:foregroundServiceType="microphone"/>
<service android:name=".service.TtsService"/>
<service android:name=".service.ComputerUseService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
    <intent-filter><action android:name="android.accessibilityservice.AccessibilityService"/></intent-filter>
    <meta-data android:name="android.accessibilityservice" android:resource="@xml/accessibility_service_config"/>
</service>
```

## CI/CD (GitHub Actions)
```yaml
# .github/workflows/build.yml
- actions/setup-java@v4 (temurin 17)
- android-actions/setup-android@v3 (api-level: 34, build-tools: 34.0.0)
- Install build-tools 34.0.0 via sdkmanager
- ./gradlew assembleRelease
- Sign with r0adkll/sign-android-release@v1 (keystore from secrets)
- Upload artifact + auto-release on tag
```

## Pitfalls & Solutions

| Issue | Solution |
|-------|----------|
| `su` not found / permission denied | Verify Magisk/KernelSU installed; check `su -c id` returns uid=0 |
| Provider 429 not caught | Check HTTP 429 + response body for "quota"/"limit"/"rate" strings |
| Function calling not working | Ensure `tools` array passed in request; `tool_choice: "auto"` |
| STT stops early | Increase `EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS` to 15000+ |
| TTS not playing | Call `startForeground()` with notification; check `setLanguage()` success |
| AccessibilityService not receiving events | User must enable in Settings > Accessibility; check `canRetrieveWindowContent=true` |
| Room migration crashes | `fallbackToDestructiveMigration()` for dev; proper migrations for prod |
| EncryptedSharedPreferences init fails | Call `PreferencesManager.init(context)` in `Application.onCreate()` |
| GitHub Actions shallow clone breaks versionCode | Use `GITHUB_RUN_NUMBER` env var instead of `git rev-list --count` |
| **Provider API key silently empty** | Data class field corrupted to `***` — restore `String` type; run clean build |
| **Dropdown selection ignored** | Dialog reads only manual EditText, not AutoCompleteTextView — read both |
| **Silent API failure (no UI error)** | Ensure `onError` callback chain complete: AiClient → HomeFragment → Toast |

---

## Provider Dialog UX Fixes (DEBSISTEN Session)

### Fields Added to "Tambah Provider" Dialog
| Field | ID | Behavior |
|-------|----|----------|
| Nama Provider | `etProviderName` | Optional, defaults to provider type name |
| Tipe Provider | `actvProviderType` | Dropdown: CUSTOM, GEMINI, OPENROUTER, ZAI, GROQ, DEEPSEEK, TOGETHER, HYPERBOLIC, SILICONFLOW |
| Base URL / Endpoint | `etBaseUrl` | **Auto-filled** when provider type selected; editable for CUSTOM |
| API Key | `etApiKey` | Required, masked input |
| Model | `etModel` + `actvModel` | Manual input + dropdown (auto-filled by provider type) |
| Aktifkan | `swEnabled` | Toggle, default ON |

### Auto-Fill Logic (on provider type selection)
```kotlin
when (selectedType) {
    "GEMINI" -> { baseUrl = "https://generativelanguage.googleapis.com/v1beta"; models = ["gemini-2.5-flash-lite", "gemini-2.5-pro"] }
    "OPENROUTER" -> { baseUrl = "https://openrouter.ai/api/v1"; models = ["deepseek-v3", "qwen3-235b", "llama-4", "gpt-4o", "gpt-4o-mini", "claude-3.5-sonnet"] }
    "GROQ" -> { baseUrl = "https://api.groq.com/openai/v1"; models = ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "gemma2-9b-it"] }
    "CUSTOM" -> { baseUrl = "https://api.openai.com/v1"; models = ["gpt-4o-mini", "gpt-4o"] }
    // ... others
}
```

### Model Selection — Read BOTH Fields
```kotlin
// BROKEN - only manual input
val model = dialogBinding.etModel.text.toString().trim()

// FIXED - dropdown priority, fallback to manual
val modelFromDropdown = dialogBinding.actvModel.text.toString().trim()
val modelFromInput = dialogBinding.etModel.text.toString().trim()
val model = modelFromDropdown.ifEmpty { modelFromInput }
```

### Test Connection Button
Same dual-read logic; validates API key + model + base URL before test call.

---

## AppLogger for Remote Debugging

Added `AppLogger` utility that writes to `files/logs.txt` in app sandbox:
```kotlin
object AppLogger {
    fun i(tag: String, msg: String) { log("INFO", tag, msg) }
    fun e(tag: String, msg: String, e: Throwable? = null) { log("ERROR", tag, msg + e?.message ?: "") }
    private fun log(level: String, tag: String, msg: String) { /* write to file + Logcat */ }
}
```

**Retrieve logs via ADB:**
```bash
adb shell run-as com.debsisten cat files/logs.txt
# OR pull entire app data (requires root/backup)
adb exec-out run-as com.debsisten tar c files/logs.txt | tar x
```

## Version Matrix (Tested)
| Component | Version |
|-----------|---------|
| Gradle | 8.7 |
| AGP | 8.5.2 |
| Kotlin | 2.0.0 |
| compileSdk/targetSdk | 34 |
| minSdk | 26 |
| Room | 2.6.1 |
| Retrofit | 2.11.0 |
| OkHttp | 4.12.0 |
| Material3 | 1.12.0 |
| EncryptedSharedPreferences | 1.1.0-alpha06 |

## File Tree (Key Files)
```
app/src/main/
├── java/com/debsisten/
│   ├── data/           # Provider, Skill, ChatMessage, PreferencesManager, AppDatabase, DAOs
│   ├── network/        # ApiModels (OpenAI/Gemini), AiClientFactory, ResponseParser
│   ├── manager/        # ProviderManager, SkillManager, AiClient
│   ├── service/        # SpeechService, TtsService, ComputerUseService
│   ├── ui/
│   │   ├── home/       # HomeFragment, ChatAdapter, HomeViewModel
│   │   ├── providers/  # ProvidersFragment, ProviderAdapter, Dialog
│   │   └── skills/     # SkillsFragment, SkillAdapter
│   ├── MainActivity.kt # ViewPager2 + BottomNav (3 tabs)
│   └── DebsistenApp.kt
├── res/
│   ├── layout/         # 11 XML (activity, fragments, items, dialogs)
│   ├── values/         # strings, colors, themes, dimens
│   ├── drawable/       # 16 vector icons + button backgrounds
│   ├── xml/            # file_paths, accessibility_service_config, backup_rules
│   └── menu/           # toolbar + bottom_nav
└── AndroidManifest.xml
```

## Quick Start Commands
```bash
# Generate keystore
keytool -genkeypair -v -keystore debsisten-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias debsisten -storepass Debsisten2026! -keypass Debsisten2026! \
  -dname "CN=DEBSISTEN, OU=DEBSISTEN, O=Debz, L=Jakarta, ST=DKI, C=ID"

# Build
./gradlew assembleDebug
./gradlew assembleRelease  # needs keystore env vars
```

## Related Patterns
- `references/flutter-youtubedl-android-integration.md` — MethodChannel + native engine pattern
- `references/openvpn-engine-integration.md` — Forking library service to capture logs
- `references/android-fgs-notification-wakelock.md` — FGS sync, wakelock, Doze exemption