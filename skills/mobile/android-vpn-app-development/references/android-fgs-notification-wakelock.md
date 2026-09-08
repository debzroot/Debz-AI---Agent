# Android FGS Notification Sync, Wakelock, Doze (VPN apps)

Debugging saga from DebNet+ — three separate user-visible bugs that all looked like "app and notification bar disagree", plus the "auto-DC after N minutes" mystery. Each fix is the *correct* Android pattern, not a hack.

## 1. FGS notification does not update via `NotificationManager.notify()`

Symptom: apk overlay says **Connected**, status-bar notification stays **Connecting…** (or reverses: app Connecting but notif Connected).

Root causes (both matter):
- `nm.notify()` from the **engine thread** does not reliably update a *foreground-service* notification. FGS notifications must be re-posted by calling `startForeground(id, notification)` again.
- Notification updates must run on the **main thread** (`Handler(Looper.getMainLooper()).post { … }`).

Correct pattern:
```kotlin
private val handler = Handler(Looper.getMainLooper())
private var notifTimer: Runnable? = null

private fun updateNotification(status: String) {
    // cancel any pending ⏱ timer callback — stale callbacks flip the
    // notification to an old state (this is the "reversed sync" bug)
    notifTimer?.let { handler.removeCallbacks(it) }
    notifTimer = null
    // build notification (title = "🌍 <ip>", not raw server id)
    if (status.contains("Connected")) {
        val timer = Runnable { updateNotification("Connected") } // ⏱ elapsed
        notifTimer = timer
        handler.postDelayed(timer, 1000)
    }
    handler.post { startForeground(NOTIF_ID, notif) } // re-post, main thread
}
```

## 2. Disconnect: notification sticks as "Connected"

FGS notifications with action buttons (e.g. a "Disconnect" action) are not reliably removed by an immediate `stopForeground(STOP_FOREGROUND_REMOVE)`. Sequence that works:

```kotlin
fun stopVpn() {
    stopEngine(); releaseLocks()
    updateNotification("Disconnected")          // 1. visibly flip text first
    handler.postDelayed({ stopForeground(STOP_FOREGROUND_REMOVE) }, 800) // 2. then remove
}
```

The `Disconnect` action itself: `PendingIntent.getService(…, ACTION_STOP, FLAG_IMMUTABLE)` handled in `onStartCommand` → `stopVpn()`.

## 3. Doze mode kills the tunnel after a few minutes

Symptom: `Session invalidated: KEEPALIVE_TIMEOUT` in engine log, always after ~2–20 min, even with the screen on earlier and user not touching anything. With the screen off, Android Doze throttles the app process → keepalive pings never reach the server → server drops the session.

Fix (all three):
1. **Partial wakelock** while CONNECTED:
   ```kotlin
   wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "app:vpn")
   wakeLock?.setReferenceCounted(false); wakeLock?.acquire()
   ```
2. **Wifi lock** (`WIFI_MODE_FULL_HIGH_PERF`) — keeps radio full-power.
3. **Battery optimization exemption** requested on first connect (mainstream VPN apps all do this):
   ```kotlin
   Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
   // Intent with Uri.parse("package:$packageName"); manifest needs
   // REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission
   ```
Acquire locks on `state == CONNECTED`, release on any other state / `stopVpn()` / `onDestroy()`.

## 4. Health-check / refresh loops must not run through the tunnel

`refresh()` defined inside a Composable captured `vpnState` from composition time (stale closure) — it kept clearing the list, re-fetching, and TCP-health-checking 66+ servers **through the active VPN tunnel** every 5 min. The tunnel got hammered → keepalive dropped → auto-DC ~20 min.

Fix: read fresh state at execution time and skip entirely while connected/connecting:
```kotlin
fun refresh() {
    scope.launch {
        val s = VpnController.state.value   // fresh, not the closure value
        if (s == CONNECTED || s == CONNECTING) return@launch  // touch nothing
        // …clear, fetch, health-check (TCP connect host:port ~1.2s)…
    }
}
```

## Verification checklist
- Connect → notification says Connected **and** timer ⏱ ticks every second.
- Tap Disconnect in the notification → notification disappears (not stuck "Connected").
- Screen off for 20+ min → still connected (wakelock + battery exemption).
- Health-check line appears in logs ONLY while idle/disconnected.
