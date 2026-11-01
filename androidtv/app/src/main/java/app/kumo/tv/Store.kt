package app.kumo.tv

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
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
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
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
    var menuSound: Boolean
        get() = sp.getBoolean("menuSound", true)
        set(v) { sp.edit().putBoolean("menuSound", v).apply(); version++ }
    /** 0 small, 1 medium, 2 large. */
    var subSize: Int
        get() = sp.getInt("subSize", 1)
        set(v) { sp.edit().putInt("subSize", v).apply(); version++ }
    var subHigh: Boolean
        get() = sp.getBoolean("subHigh", false)
        set(v) { sp.edit().putBoolean("subHigh", v).apply(); version++ }
    var skipFiller: Boolean
        get() = sp.getBoolean("skipFiller", false)
        set(v) { sp.edit().putBoolean("skipFiller", v).apply(); version++ }

    // Choices made in the player belong to that show; Settings holds the defaults.
    fun subSizeFor(id: Int) = sp.getInt("subSize:$id", subSize)
    fun setSubSize(id: Int, v: Int) { sp.edit().putInt("subSize:$id", v).apply(); version++ }
    fun subHighFor(id: Int) = sp.getBoolean("subHigh:$id", subHigh)
    fun setSubHigh(id: Int, v: Boolean) { sp.edit().putBoolean("subHigh:$id", v).apply(); version++ }
    fun audioLang(id: Int) = sp.getString("audioLang:$id", null)
    fun setAudioLang(id: Int, lang: String) { sp.edit().putString("audioLang:$id", lang).apply() }
    fun subLang(id: Int) = sp.getString("subLang:$id", null)
    fun subOff(id: Int) = sp.getBoolean("subOff:$id", false)
    fun setSubLang(id: Int, lang: String?) {
        val e = sp.edit().putBoolean("subOff:$id", false)
        if (lang != null) e.putString("subLang:$id", lang)
        e.apply()
    }
    fun setSubOff(id: Int) { sp.edit().putBoolean("subOff:$id", true).apply() }

    // ---- AniList link: the token stays on this TV ----
    val aniListToken get() = sp.getString("anilistToken", null)
    var aniListName by mutableStateOf<String?>(null)
    fun setAniList(token: String, name: String) {
        sp.edit().putString("anilistToken", token).putString("anilistName", name).apply()
        aniListName = name
    }
    fun clearAniList() {
        sp.edit().remove("anilistToken").remove("anilistName").remove("anilistQueue").apply()
        aniListName = null
    }
    fun aniListQueue(): Set<String> = sp.getStringSet("anilistQueue", emptySet()) ?: emptySet()
    fun queueAniList(item: String) { sp.edit().putStringSet("anilistQueue", aniListQueue() + item).apply() }
    fun unqueueAniList(item: String) { sp.edit().putStringSet("anilistQueue", aniListQueue() - item).apply() }

    /** The Sub, Dub or Other last chosen for this show. */
    fun kindFor(id: Int): Audio? = sp.getString("kind:$id", null)?.let { name -> Audio.entries.firstOrNull { it.name == name } }
    fun setKind(id: Int, kind: Audio) { sp.edit().putString("kind:$id", kind.name).remove("audioLang:$id").apply() }

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
        knownAddons = addons.map { it.url }.toSet()
        goneAddons.addAll(sp.getStringSet("addonsGone", emptySet()).orEmpty())
        sp.edit().remove("goneAddons").apply()
        accountEmail = sp.getString("email", null)
        aniListName = sp.getString("anilistName", null)
    }

    private fun obj(key: String) = runCatching { JSONObject(sp.getString(key, "{}") ?: "{}") }.getOrDefault(JSONObject())
    private var batching = false

    private fun persist() {
        if (batching) return
        sp.edit().putString("progress", progress.toString()).putString("watchlist", watchlist.toString()).putString("removed", removed.toString()).apply()
        version++
    }

    // Add-ons removed while signed in, as hashes, until the account's copy has been updated.
    // One removed while signed out comes back at the next sign-in: the account still holds it.
    private var knownAddons = emptySet<String>()
    private val goneAddons = HashSet<String>()
    private fun addonHash(url: String) = MessageDigest.getInstance("SHA-256").digest(url.toByteArray())
        .joinToString("") { "%02x".format(it) }

    private fun storeAddons() {
        val urls = addons.map { it.url }.toSet()
        if (accountEmail != null) (knownAddons - urls).forEach { goneAddons.add(addonHash(it)) }
        urls.forEach { goneAddons.remove(addonHash(it)) }
        knownAddons = urls
        val a = JSONArray()
        addons.forEach { a.put(it.toJson()) }
        sp.edit().putString("addons", a.toString()).putStringSet("addonsGone", HashSet(goneAddons)).apply()
        addonVersion++
    }

    fun saveAddons() {
        storeAddons()
        scheduleSync()
    }

    /** Add-ons saved with the account join the ones on this TV. Nothing on the TV is removed. */
    private fun mergeAddons(cloud: JSONObject?) {
        var added = false
        cloud?.optJSONArray("list")?.objects()?.forEach { o ->
            val url = o.str("url") ?: return@forEach
            val manifest = o.optJSONObject("manifest") ?: return@forEach
            if (addonHash(url) !in goneAddons && addons.none { it.url == url }) {
                addons.add(Addon(url, manifest, o.optBoolean("enabled", true)))
                added = true
            }
        }
        if (added) storeAddons()
        Log.d("KumoSync", "account add-ons ${cloud?.optJSONArray("list")?.length() ?: -1}, on TV ${addons.size}, added $added")
    }

    // ---- bell ----
    private val pressedNews get() = sp.getStringSet("pressedNews", emptySet()) ?: emptySet()
    fun newsPressed(id: Int, ep: Int) = "$id:$ep" in pressedNews
    fun pressNews(id: Int, ep: Int) {
        sp.edit().putStringSet("pressedNews", pressedNews + "$id:$ep").apply()
        version++
    }

    private val clearedNews get() = sp.getStringSet("clearedNews", emptySet()) ?: emptySet()
    fun newsCleared(id: Int, ep: Int) = "$id:$ep" in clearedNews
    fun clearNews(items: List<Pair<Int, Int>>) {
        sp.edit().putStringSet("clearedNews", clearedNews + items.map { (id, ep) -> "$id:$ep" }).apply()
        version++
    }

    // ---- watching ----
    fun inWatchlist(route: String) = watchlist.has(route)
    fun toggleWatch(route: String, title: String, poster: String?) {
        if (watchlist.has(route)) { watchlist.remove(route); removed.put(route, now()) }
        else watchlist.put(route, JSONObject().put("route", route).put("title", title).put("poster", poster ?: JSONObject.NULL).put("added", now()))
        persist(); scheduleSync()
        if (watchlist.has(route)) route.substringAfterLast('/').toIntOrNull()?.let { AniListSync.queue(it, 0) }
    }

    private fun now() = System.currentTimeMillis()
    private fun keys(o: JSONObject) = o.keys().asSequence().toList()

    fun saveProgress(key: String, t: Double, d: Double, route: String, title: String, poster: String?, label: String) {
        val row = progress.optJSONObject(key) ?: JSONObject()
        val before = row.optDouble("d", 0.0).let { if (it > 0) row.optDouble("t", 0.0) / it else 0.0 }
        row.remove("hidden")
        row.put("t", t).put("d", d).put("route", route).put("title", title).put("poster", poster ?: JSONObject.NULL).put("label", label).put("updated", now())
        progress.put(key, row)
        persist(); scheduleSync()
        if (d > 0 && t / d > 0.92 && before <= 0.92) {
            val id = route.substringAfterLast('/').toIntOrNull()
            val ep = key.removePrefix("$route:").toIntOrNull()
            if (id != null && ep != null) AniListSync.queue(id, ep)
        }
    }

    class Stats(val hours: Double, val episodes: Int, val shows: Int, val month: Int, val top: List<Pair<String, Double>>, val ids: List<Int>)

    /** Worked out from saved progress. Episodes only marked as watched count as finished but add no time. */
    fun stats(): Stats {
        val time = HashMap<String, Double>()
        val names = HashMap<String, String>()
        var finished = 0
        var month = 0
        val start = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.DAY_OF_MONTH, 1); set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
        }.timeInMillis
        for (k in keys(progress)) {
            val p = progress.optJSONObject(k) ?: continue
            val route = p.str("route") ?: continue
            val d = p.optDouble("d", 0.0)
            val t = p.optDouble("t", 0.0)
            if (d <= 0 || t <= 0) continue
            names[route] = p.str("title") ?: ""
            val played = if (d == 1000.0 && t == 1000.0) 0.0 else minOf(t, d)
            time[route] = (time[route] ?: 0.0) + played
            if (t / d > 0.92) {
                finished++
                if (p.optLong("updated") >= start) month++
            }
        }
        val ranked = time.entries.sortedByDescending { it.value }
        return Stats(time.values.sum() / 3600, finished, time.size, month, ranked.take(5).map { (names[it.key] ?: "") to it.value / 3600 }, ranked.mapNotNull { it.key.substringAfterLast('/').toIntOrNull() })
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

    /** Saved once at the end, as a long series would otherwise rewrite everything per episode. */
    fun markAll(route: String, eps: IntRange, on: Boolean, title: String, poster: String?) {
        batching = true
        try { eps.forEach { markWatched(route, it, on, title, poster) } } finally { batching = false }
        persist(); scheduleSync()
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
    private const val ADDONS_KEY = "_addons"
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
            val row = JSONArray(r.body).optJSONObject(0)
            // The add-ons travel inside the progress column under a key of their own.
            val cloud = row?.optJSONObject("progress")?.remove(ADDONS_KEY) as? JSONObject
            withContext(Dispatchers.Main) { mergeAddons(cloud) }
            merge(row)
            push(user, auth)
        }.onFailure { syncState = fail }
    }

    private suspend fun push(user: String, auth: Map<String, String>) {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val list = withContext(Dispatchers.Main) { JSONArray().also { a -> addons.forEach { a.put(it.toJson()) } } }
        val saved = JSONObject(progress.toString()).put(ADDONS_KEY, JSONObject().put("list", list))
        val row = JSONObject().put("user_id", user).put("watchlist", watchlist).put("progress", saved).put("updated_at", iso)
        val r = Net.post("$URL/rest/v1/user_data?on_conflict=user_id", JSONArray().put(row).toString(), auth + ("Prefer" to "resolution=merge-duplicates"))
        syncState = if (r.ok) "Synced" else "Couldn't sync. Check the connection."
        Log.d("KumoSync", "saved ${list.length()} add-ons: ${r.ok}")
        if (r.ok) withContext(Dispatchers.Main) {
            goneAddons.clear()
            sp.edit().putStringSet("addonsGone", emptySet()).apply()
        }
    }

    private fun scheduleSync() {
        if (accountEmail == null) return
        syncJob?.cancel()
        syncJob = scope.launch { delay(5000); sync() }
    }
}
