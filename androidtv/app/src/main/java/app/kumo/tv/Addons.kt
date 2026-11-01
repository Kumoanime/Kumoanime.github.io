package app.kumo.tv

import android.net.Uri
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

object Addons {
    private fun normalise(raw: String): String {
        var u = raw.trim()
        if (u.lowercase().startsWith("stremio://")) u = "https://" + u.substring(10)
        if (!u.lowercase().startsWith("http://") && !u.lowercase().startsWith("https://")) u = "https://$u"
        return u
    }

    fun resourceUrl(manifestUrl: String, path: String): String {
        val cut = manifestUrl.substringBefore('?')
        val query = manifestUrl.substringAfter('?', "")
        val base = cut.removeSuffix("/manifest.json").trimEnd('/')
        return "$base/$path" + if (query.isEmpty()) "" else "?$query"
    }

    private fun enc(s: String) = Uri.encode(s, ":")

    suspend fun install(raw: String): Addon {
        val n = normalise(raw)
        val url = if (n.lowercase().contains("manifest.json")) n else n.trimEnd('/') + "/manifest.json"
        val r = Net.get(url)
        if (!r.ok) throw Exception("The link answered with error ${r.code}")
        val m = runCatching { JSONObject(r.body) }.getOrNull()
        if (m == null || m.str("id") == null || !m.has("resources")) throw Exception("That link isn't an add-on manifest")
        return Addon(url, m)
    }

    private data class Candidate(val id: String, val anime: Boolean)

    private fun candidates(ids: ShowIds, ep: Int, movie: Boolean): List<Candidate> = buildList {
        val season = ids.imdbSeason ?: 1
        ids.kitsu?.let { add(Candidate(if (movie) "kitsu:$it" else "kitsu:$it:$ep", true)) }
        ids.imdb?.let { add(Candidate(if (movie) it else "$it:$season:$ep", false)) }
        ids.mal?.let { add(Candidate(if (movie) "mal:$it" else "mal:$it:$ep", true)) }
        ids.tmdb?.let { add(Candidate(if (movie) "tmdb:$it" else "tmdb:$it:$season:$ep", false)) }
        add(Candidate("anilist:${ids.anilist}:$ep", true))
    }

    /** Releases are often filed under only one of a show's ids, so each id gets its own request. */
    private suspend fun streamsFor(a: Addon, spec: Pair<List<String>, List<String>?>, c: Candidate, movie: Boolean): List<Stream> {
        val type = if (movie) "movie" else if (c.anime && "anime" in spec.first) "anime" else "series"
        if (spec.first.isNotEmpty() && type !in spec.first) return emptyList()
        val r = runCatching { Net.get(resourceUrl(a.url, "stream/${enc(type)}/${enc(c.id)}.json")) }.getOrNull()
        if (r == null || !r.ok) return emptyList()
        return runCatching { JSONObject(r.body).optJSONArray("streams").objects().map(Stream::parse) }.getOrDefault(emptyList())
    }

    /** Subtitles from every subtitle add-on, English first. */
    suspend fun subtitles(addons: List<Addon>, ids: ShowIds, ep: Int, movie: Boolean): List<Subtitle> = coroutineScope {
        addons.filter { it.enabled && it.spec("subtitles") != null }.map { a ->
            async {
                val spec = a.spec("subtitles") ?: return@async emptyList()
                val c = candidates(ids, ep, movie).firstOrNull { a.handles("subtitles", it.id) } ?: return@async emptyList()
                val type = if (movie) "movie" else if (c.anime && "anime" in spec.first) "anime" else "series"
                val r = runCatching { Net.get(resourceUrl(a.url, "subtitles/${enc(type)}/${enc(c.id)}.json")) }.getOrNull()
                if (r == null || !r.ok) return@async emptyList()
                runCatching {
                    JSONObject(r.body).optJSONArray("subtitles").objects().mapNotNull { s ->
                        s.str("url")?.let { Subtitle(it, s.str("lang") ?: "") }
                    }
                }.getOrDefault(emptyList())
            }
        }.flatMap { it.await() }.sortedBy { if (it.lang.lowercase().startsWith("en")) 0 else 1 }
    }

    /** Emits each add-on's playable sources as soon as it answers. */
    fun streams(addons: List<Addon>, ids: ShowIds, ep: Int, movie: Boolean): Flow<Pair<Addon, List<Stream>>> = channelFlow {
        coroutineScope {
            addons.filter { it.enabled }.forEach { a ->
                val spec = a.spec("stream") ?: return@forEach
                val seen = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
                // Sent as each id answers, so one slow id doesn't hold back the rest.
                candidates(ids, ep, movie).filter { a.handles("stream", it.id) }.take(3).forEach { c ->
                    launch {
                        // While an add-on refreshes it answers with a status row, not sources, so ask again.
                        var list = streamsFor(a, spec, c, movie)
                        repeat(4) {
                            if (list.isEmpty() || !list.all(StreamLogic::isStatus)) return@repeat
                            delay(5_000)
                            list = streamsFor(a, spec, c, movie)
                        }
                        val fresh = list.filter { !StreamLogic.isStatus(it) && !it.url.isNullOrEmpty() && seen.add(it.filename?.lowercase() ?: it.url!!) }
                        if (fresh.isNotEmpty()) send(a to fresh)
                    }
                }
            }
        }
    }
}

object StreamLogic {
    private fun has(pattern: String, text: String) = Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(text)

    /** Comet's "working on it" row: it has a link but isn't a video. */
    fun isStatus(s: Stream) = s.filename == null && s.name?.contains("\uD83D\uDD04") == true

    fun isDebrid(s: Stream): Boolean {
        val u = s.url ?: ""
        return has("/playback/|/resolve/|real-?debrid", u) || has("\\[(RD|AD|PM|TB|DL)[^\\]]*\\]", s.name ?: "")
    }

    fun isCached(s: Stream): Boolean {
        val n = "${s.name ?: ""} ${s.title ?: ""}"
        if (n.contains("⚡")) return true
        if (has("\\[(RD|AD|PM|TB|DL)\\+\\]", n)) return true
        return has("\\bRD\\+|\\bcached\\b", n) && !has("not cached|uncached", n)
    }

    fun isUncached(s: Stream): Boolean {
        if (isCached(s)) return false
        val n = "${s.name ?: ""} ${s.title ?: ""}"
        return n.contains("⬇") || n.contains("↓") || has("\\[(RD|AD|PM) download\\]|uncached|not cached", n)
    }

    fun audio(s: Stream): Audio {
        val t = "${s.name ?: ""} ${s.title ?: ""} ${s.description ?: ""} ${s.filename ?: ""}"
        return when {
            has("(?<![a-z])dub(bed|s)?(?![a-z])|(?<![a-z])dual(?![a-z])|multi[- ]?audio|(?<![a-z])eng?(lish)? ?[+&/] ?(ja|jp|jpn|jap|japanese)(?![a-z])|(?<![a-z])(ja|jp|jpn|jap|japanese) ?[+&/] ?eng?(lish)?(?![a-z])|(?<![a-z])eng(lish)?[ ._-]?audio", t) -> Audio.DUB
            // Most anime releases never say "sub": they name a fansub group or Japanese audio.
            has("(?<![a-z])sub(bed|s|titles?)?(?![a-z])|soft ?sub|hard ?sub|multi[- ]?subs?|(?<![a-z])e?subs?please|[a-z]subs(?![a-z])|erai-?raws|(?<![a-z])(jpn|jap|japanese)(?![a-z])|\uD83C\uDDEF\uD83C\uDDF5", t) -> Audio.SUB
            else -> Audio.OTHER
        }
    }

    /** This TV has no AV1 decoder, so these are only worth trying last. */
    private fun isAv1(s: Stream) = has("(?<![a-z0-9])av-?0?1(?![a-z0-9])", "${s.name ?: ""} ${s.title ?: ""} ${s.description ?: ""} ${s.filename ?: ""}")

    private fun rank(s: Stream) = if (isCached(s)) 100 else if (isUncached(s)) 10 else 40

    fun order(rows: List<StreamRow>, prefer: Audio): List<StreamRow> {
        val audioRank = if (prefer == Audio.DUB) mapOf(Audio.DUB to 0, Audio.OTHER to 1, Audio.SUB to 2)
        else mapOf(Audio.SUB to 0, Audio.OTHER to 1, Audio.DUB to 2)
        return rows.sortedWith(compareBy<StreamRow> { isAv1(it.stream) }.thenBy { audioRank[it.audio] }.thenByDescending { rank(it.stream) }.thenBy { it.index })
    }

    /** Cached sources in order, or everything when nothing is cached. */
    fun autoCandidates(rows: List<StreamRow>, prefer: Audio): List<StreamRow> {
        val ordered = order(rows, prefer)
        // A cached AV1 file can't play here, so it mustn't hide the files that can.
        val playable = ordered.filterNot { isAv1(it.stream) }
        val cached = playable.filter { isCached(it.stream) }
        return cached.ifEmpty { playable.filter { !isUncached(it.stream) }.ifEmpty { playable } }.ifEmpty { ordered }
    }
}
