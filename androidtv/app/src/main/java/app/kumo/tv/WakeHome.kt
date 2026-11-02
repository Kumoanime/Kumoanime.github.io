package app.kumo.tv

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Standby on this TV keeps the last app in front, so it wakes inside that app. As the screen goes off this presses
 * Home, the only way Android lets a background app change what's in front, and the TV wakes on the home screen.
 * Turned on over ADB with secure enabled_accessibility_services=app.kumo.tv/.WakeHome.
 */
class WakeHome : AccessibilityService() {
    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            Log.d("KumoWake", "screen off, going Home: ${performGlobalAction(GLOBAL_ACTION_HOME)}")
        }
    }

    override fun onServiceConnected() {
        registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(screenOff) }
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
}
