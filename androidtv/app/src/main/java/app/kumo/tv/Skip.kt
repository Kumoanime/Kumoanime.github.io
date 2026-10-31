package app.kumo.tv

import android.util.Log
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.math.abs

private typealias Window = ClosedFloatingPointRange<Double>

class SkipTimes(val op: Window?, val ed: Window?)

/**
 * Asks three community databases on every play, so a new episode gets its times
 * as soon as anyone submits them, and keeps the times they agree on.
 */
object SkipSources {
    private const val AGREE_SECONDS = 4.0

    private suspend fun aniSkip(mal: Int?, ep: Int, duration: Double): SkipTimes? {
        if (mal == null) return null
        val r = Net.get("https://api.aniskip.com/v2/skip-times/$mal/$ep?types[]=op&types[]=ed&episodeLength=${duration.toInt()}")
        if (!r.ok) return null
        val root = JSONObject(r.body)
        if (!root.optBoolean("found")) return null
        var op: Window? = null
        var ed: Window? = null
        root.optJSONArray("results").objects().forEach { row ->
            val i = row.optJSONObject("interval") ?: return@forEach
            val start = i.optDouble("startTime")
            val end = i.optDouble("endTime")
            if (!(end > start)) return@forEach
            when (row.str("skipType")) {
                "op" -> op = start..end
                "ed" -> ed = start..end
            }
        }
        return SkipTimes(op, ed)
    }

    private fun window(o: JSONObject?, duration: Double): Window? {
        if (o == null) return null
        val start = if (o.isNull("start_ms")) 0.0 else o.optDouble("start_ms") / 1000
        val end = if (o.isNull("end_ms")) duration else o.optDouble("end_ms") / 1000
        return if (end > start) start..end else null
    }

    private suspend fun theIntroDb(ids: ShowIds, ep: Int, duration: Double): SkipTimes? {
        val tmdb = ids.tmdb ?: return null
        val r = Net.get("https://api.theintrodb.org/v2/media?tmdb_id=$tmdb&season=${ids.imdbSeason ?: 1}&episode=$ep")
        if (!r.ok) return null
        val o = JSONObject(r.body)
        return SkipTimes(window(o.optJSONArray("intro")?.optJSONObject(0), duration), window(o.optJSONArray("credits")?.optJSONObject(0), duration))
    }

    private suspend fun introDb(ids: ShowIds, ep: Int, duration: Double): SkipTimes? {
        val imdb = ids.imdb ?: return null
        val r = Net.get("https://api.introdb.app/segments?imdb_id=$imdb&season=${ids.imdbSeason ?: 1}&episode=$ep")
        if (!r.ok) return null
        val o = JSONObject(r.body)
        return SkipTimes(window(o.optJSONObject("intro"), duration), window(o.optJSONObject("outro"), duration))
    }

    private fun near(a: Window, b: Window) = abs(a.start - b.start) < AGREE_SECONDS && abs(a.endInclusive - b.endInclusive) < AGREE_SECONDS

    /** The window most sources agree on. On a tie the earliest source wins, and AniSkip is first. */
    private fun agreed(list: List<Window>): Window? = list.maxByOrNull { a -> list.count { near(a, it) } }

    private suspend fun episode(ids: ShowIds, ep: Int, duration: Double): SkipTimes = coroutineScope {
        fun guarded(block: suspend () -> SkipTimes?) = async { withTimeoutOrNull(8000) { runCatching { block() }.getOrNull() } }
        val found = listOf(guarded { aniSkip(ids.mal, ep, duration) }, guarded { theIntroDb(ids, ep, duration) }, guarded { introDb(ids, ep, duration) }).awaitAll().filterNotNull()
        Log.d("KumoSkip", "ep $ep: ${found.size} of 3 sources answered, op ${found.mapNotNull { it.op }} ed ${found.mapNotNull { it.ed }}")
        SkipTimes(agreed(found.mapNotNull { it.op }), agreed(found.mapNotNull { it.ed }))
    }

    /**
     * A new episode often has no data yet. Its times are borrowed from the two
     * episodes before it, but only when those two match, which means the show
     * keeps its opening and ending in the same place.
     */
    suspend fun find(ids: ShowIds, ep: Int, duration: Double): SkipTimes {
        val now = episode(ids, ep, duration)
        if ((now.op != null && now.ed != null) || ep < 3) return now
        val a = episode(ids, ep - 1, duration)
        val b = episode(ids, ep - 2, duration)
        val pattern = { x: Window?, y: Window? -> if (x != null && y != null && near(x, y)) x else null }
        return SkipTimes(now.op ?: pattern(a.op, b.op), now.ed ?: pattern(a.ed, b.ed))
    }

    fun inside(t: Double, w: Window?) = w != null && t >= w.start && t < w.endInclusive - 0.35
}
