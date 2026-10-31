package app.kumo.tv

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Watch data uses the website's JSON shape so one account works on both. */
object Store {
    private lateinit var sp: SharedPreferences
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var syncJob: Job? = null

    var progress = JSONObject(); private set
    var watchlist = JSONObject(); private set
    private var removed = JSONObject()
    val addons = ArrayList<Addon>()

    /** Compose reads this to know when progress or the list changed. */
    var version by mutableIntStateOf(0)
    var addonVersion by mutableIntStateOf(0)
    var accountEmail by mutableStateOf<String?>(null)
    var syncState by mutableStateOf("")

    var autoNext: Boolean
        get() = sp.getBoolean("autoNext", true)
        set(v) { sp.edit().putBoolean("autoNext", v).apply(); version++ }
    var autoSkip: Boolean
        get() = sp.getBoolean("autoSkip", false)
        set(v) { sp.edit().putBoolean("autoSkip", v).apply(); version++ }
    var prefer: Audio
        get() = if (sp.getString("audio", "sub") == "dub") Audio.DUB else Audio.SUB
        set(v) { sp.edit().putString("audio", if (v == Audio.DUB) "dub" else "sub").apply(); version++ }

    fun init(context: Context) {
        sp = context.getSharedPreferences("kumo", Context.MODE_PRIVATE)
        progress = obj("progress")
        watchlist = obj("watchlist")
        removed = obj("removed")
        runCatching {
            JSONArray(sp.getString("addons", "[]")).objects().forEach {
                addons.add(Addon(it.getString("url"), it.getJSONObject("manifest"), it.optBoolean("enabled", true)))
            }
        }
        accountEmail = sp.getString("email", null)
    }

    private fun obj(key: String) = runCatching { JSONObject(sp.getString(key, "{}") ?: "{}") }.getOrDefault(JSONObject())
    private fun persist() {
        sp.edit().putString("progress", progress.toString()).putString("watchlist", watchlist.toString()).putString("removed", removed.toString()).apply()
        version++
    }

    fun saveAddons() {
        val a = JSONArray()
        addons.forEach { a.put(it.toJson()) }
        sp.edit().putString("addons", a.toString()).apply()
        addonVersion++
    }

    // ---- watching ----
    fun inWatchlist(route: String) = watchlist.has(route)
    fun toggleWatch(route: String, title: String, poster: String?) {
        if (watchlist.has(route)) { watchlist.remove(route); removed.put(route, now()) }
        else watchlist.put(route, JSONObject().put("route", route).put("title", title).put("poster", poster ?: JSONObject.NULL).put("added", now()))
        persist(); scheduleSync()
    }

    private fun now() = System.currentTimeMillis()
    private fun keys(o: JSONObject) = o.keys().asSequence().toList()

    fun saveProgress(key: String, t: Double, d: Double, route: String, title: String, poster: String?, label: String) {
        val row = progress.optJSONObject(key) ?: JSONObject()
        row.remove("hidden")
        row.put("t", t).put("d", d).put("route", route).put("title", title).put("poster", poster ?: JSONObject.NULL).put("label", label).put("updated", now())
        progress.put(key, row)
        persist(); scheduleSync()
    }

    fun rowFor(route: String, ep: Int): JSONObject? = progress.optJSONObject("$route:$ep")
    fun percent(route: String, ep: Int): Float {
        val p = rowFor(route, ep) ?: return 0f
        val d = p.optDouble("d", 0.0)
        return if (d > 0) (p.optDouble("t", 0.0) / d).toFloat().coerceIn(0f, 1f) else 0f
    }

    fun markWatched(route: String, ep: Int, on: Boolean, title: String, poster: String?) {
        if (on) {
            val d = rowFor(route, ep)?.optDouble("d", 0.0)?.takeIf { it > 1 } ?: 1000.0
            saveProgress("$route:$ep", d, d, route, title, poster, "Episode $ep")
        } else rowFor(route, ep)?.let {
            it.put("t", 0).put("hidden", true).put("updated", now())
            persist(); scheduleSync()
        }
    }

    fun hideFromContinue(route: String) {
        val at = now()
        keys(progress).forEach { k -> progress.optJSONObject(k)?.takeIf { it.str("route") == route }?.put("hidden", true)?.put("updated", at) }
        persist(); scheduleSync()
    }

    class ContinueRow(val route: String, val ep: Int?, val title: String, val poster: String?, val label: String, val pct: Float, val updated: Long)

    fun continueRows(): List<ContinueRow> {
        val best = HashMap<String, ContinueRow>()
        for (k in keys(progress)) {
            val p = progress.optJSONObject(k) ?: continue
            val route = p.str("route") ?: continue
            val d = p.optDouble("d", 0.0)
            val t = p.optDouble("t", 0.0)
            if (p.optBoolean("hidden") || (d > 0 && t / d > 0.92)) continue
            val updated = p.optLong("updated")
            if ((best[route]?.updated ?: -1) >= updated) continue
            best[route] = ContinueRow(route, k.removePrefix("$route:").toIntOrNull(), p.str("title") ?: "", p.str("poster"), p.str("label") ?: "", if (d > 0) (t / d).toFloat() else 0f, updated)
        }
        return best.values.sortedByDescending { it.updated }
    }

    fun nextEpisode(route: String): Int {
        var last = 0
        for (k in keys(progress)) {
            if (!k.startsWith("$route:")) continue
            val n = k.substringAfterLast(':').toIntOrNull() ?: continue
            val p = progress.optJSONObject(k) ?: continue
            val d = p.optDouble("d", 0.0)
            val t = p.optDouble("t", 0.0)
            if (d > 0 && t / d > 0.92) last = maxOf(last, n) else if (t > 0) last = maxOf(last, n - 1)
        }
        return last + 1
    }

    fun watchingItems(): List<JSONObject> = keys(watchlist).mapNotNull { watchlist.optJSONObject(it) }.sortedByDescending { it.optLong("added") }

    // ---- account: Supabase auth and the user_data table ----
    private const val URL = "https://xaiwuqyudxmypdairyab.supabase.co"
    private const val KEY = "sb_publishable_XH_vVGedmDfC0KTNUqpWbA_q35TWZXL"
    private val anon get() = mapOf("apikey" to KEY)

    private fun keep(o: JSONObject) {
        sp.edit().putString("access", o.getString("access_token")).putString("refresh", o.getString("refresh_token"))
            .putString("user", o.getJSONObject("user").getString("id"))
            .putString("email", o.getJSONObject("user").str("email"))
            .putLong("expires", now() + o.optLong("expires_in", 3600) * 1000 - 60_000).apply()
        accountEmail = sp.getString("email", null)
    }

    suspend fun login(email: String, password: String) {
        val body = JSONObject().put("email", email).put("password", password).toString()
        val r = Net.post("$URL/auth/v1/token?grant_type=password", body, anon)
        if (!r.ok) throw Exception(runCatching { JSONObject(r.body).let { it.str("error_description") ?: it.str("msg") } }.getOrNull() ?: "Couldn't log in")
        keep(JSONObject(r.body))
        sync()
    }

    fun logout() {
        sp.edit().remove("access").remove("refresh").remove("user").remove("email").remove("expires").apply()
        accountEmail = null; syncState = ""
    }

    private suspend fun token(): String? {
        val refresh = sp.getString("refresh", null) ?: return null
        if (now() < sp.getLong("expires", 0)) return sp.getString("access", null)
        val r = Net.post("$URL/auth/v1/token?grant_type=refresh_token", JSONObject().put("refresh_token", refresh).toString(), anon)
        if (!r.ok) return null
        keep(JSONObject(r.body))
        return sp.getString("access", null)
    }

    private fun merge(remote: JSONObject?) {
        val rw = remote?.optJSONObject("watchlist") ?: JSONObject()
        val rp = remote?.optJSONObject("progress") ?: JSONObject()
        keys(watchlist).forEach { r ->
            val item = watchlist.getJSONObject(r)
            if (!rw.has(r) || item.optLong("added") > (rw.optJSONObject(r)?.optLong("added") ?: 0)) rw.put(r, item)
        }
        keys(removed).forEach { r -> if (rw.has(r) && (rw.optJSONObject(r)?.optLong("added") ?: 0) < removed.optLong(r)) rw.remove(r) }
        keys(progress).forEach { k ->
            val v = progress.getJSONObject(k)
            if (!rp.has(k) || v.optLong("updated") > (rp.optJSONObject(k)?.optLong("updated") ?: 0)) rp.put(k, v)
        }
        watchlist = rw; progress = rp
        persist()
    }

    suspend fun sync() {
        val access = token() ?: return
        val user = sp.getString("user", null) ?: return
        val auth = anon + ("Authorization" to "Bearer $access")
        val fail = "Couldn't sync. Check the connection."
        runCatching {
            val r = Net.get("$URL/rest/v1/user_data?user_id=eq.$user&select=watchlist,progress", auth)
            if (!r.ok) { syncState = fail; return }
            merge(JSONArray(r.body).optJSONObject(0))
            push(user, auth)
        }.onFailure { syncState = fail }
    }

    private suspend fun push(user: String, auth: Map<String, String>) {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val row = JSONObject().put("user_id", user).put("watchlist", watchlist).put("progress", progress).put("updated_at", iso)
        val r = Net.post("$URL/rest/v1/user_data?on_conflict=user_id", JSONArray().put(row).toString(), auth + ("Prefer" to "resolution=merge-duplicates"))
        syncState = if (r.ok) "Synced" else "Couldn't sync. Check the connection."
    }

    private fun scheduleSync() {
        if (accountEmail == null) return
        syncJob?.cancel()
        syncJob = scope.launch { delay(5000); sync() }
    }
}
