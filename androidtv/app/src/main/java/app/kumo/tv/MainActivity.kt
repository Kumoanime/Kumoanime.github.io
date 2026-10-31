package app.kumo.tv

import android.app.Application
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.lifecycleScope
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import kotlinx.coroutines.launch

class KumoApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
    }

    // This TV has little memory, so artwork stays small and uncrossfaded.
    override fun newImageLoader() = ImageLoader.Builder(this)
        .allowRgb565(true)
        .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.15).build() }
        .diskCache { DiskCache.Builder().directory(cacheDir.resolve("img")).maxSizeBytes(40L * 1024 * 1024).build() }
        .build()
}

sealed class Route {
    data object Tabs : Route()
    data class Show(val id: Int) : Route()
    data class Watch(val id: Int, val ep: Int, val auto: Boolean) : Route()
    data class Player(val session: PlaySession) : Route()
    data object Addons : Route()
    data object PhoneSetup : Route()
    data object Account : Route()
}

object Nav {
    val stack = mutableStateListOf<Route>(Route.Tabs)
    private val saved = ArrayList<String?>()
    var lastFocus: String? = null
    var restore by mutableStateOf<String?>("home:first")

    fun push(r: Route) { saved.add(lastFocus); stack.add(r) }
    fun pop() {
        if (stack.size <= 1) return
        stack.removeAt(stack.lastIndex)
        restore = saved.removeLastOrNull()
    }
    fun replace(r: Route) { stack[stack.lastIndex] = r }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        addFromIntent(intent)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Orange, background = Color.Black)) {
                Box(Modifier.fillMaxSize().background(Color.Black)) {
                    BackHandler(Nav.stack.size > 1) { Nav.pop() }
                    when (val r = Nav.stack.last()) {
                        Route.Tabs -> TabsScreen()
                        is Route.Show -> ShowScreen(r.id)
                        is Route.Watch -> WatchScreen(r)
                        is Route.Player -> PlayerScreen(r.session)
                        Route.Addons -> AddonsScreen()
                        Route.PhoneSetup -> PhoneSetupScreen()
                        Route.Account -> AccountScreen()
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        addFromIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { Store.sync() }
    }

    /** Lets a long add-on link be sent over ADB instead of typed with the remote. */
    private fun addFromIntent(intent: android.content.Intent?) {
        val url = intent?.getStringExtra("addon") ?: return
        lifecycleScope.launch {
            runCatching { Addons.install(url) }
                .onSuccess { a -> Store.addons.removeAll { it.url == a.url }; Store.addons.add(a); Store.saveAddons(); Toast.makeText(this@MainActivity, "Added ${a.name}", Toast.LENGTH_LONG).show() }
                .onFailure { Toast.makeText(this@MainActivity, it.message ?: "Couldn't add that add-on", Toast.LENGTH_LONG).show() }
        }
    }
}
