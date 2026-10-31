package app.kumo.tv

import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

object AniList {
    private const val FIELDS = "id idMal title{romaji english} coverImage{large} bannerImage format status episodes seasonYear averageScore genres description(asHtml:false) nextAiringEpisode{episode airingAt} trailer{id site}"
    private val cache = HashMap<Int, Media>()

    private suspend fun graph(query: String, vars: JSONObject): JSONObject {
        val body = JSONObject().put("query", query).put("variables", vars).toString()
        val r = Net.post("https://graphql.anilist.co", body)
        if (!r.ok) throw Exception("AniList answered ${r.code}")
        return JSONObject(r.body).optJSONObject("data") ?: throw Exception("AniList didn't answer")
    }

    suspend fun list(sort: String, season: String? = null, year: Int? = null, status: String? = null, search: String? = null): List<Media> {
        val q = "query(\$sort:[MediaSort],\$season:MediaSeason,\$year:Int,\$status:MediaStatus,\$search:String){Page(perPage:30){media(type:ANIME,isAdult:false,sort:\$sort,season:\$season,seasonYear:\$year,status:\$status,search:\$search){$FIELDS}}}"
        val v = JSONObject().put("sort", JSONArray().put(sort))
        season?.let { v.put("season", it) }
        year?.let { v.put("year", it) }
        status?.let { v.put("status", it) }
        search?.let { v.put("search", it) }
        val items = graph(q, v).optJSONObject("Page")?.optJSONArray("media").objects().map(Media::parse)
        return items.onEach { m -> if (!cache.containsKey(m.id)) cache[m.id] = m }
    }

    private const val SEARCH = "query(\$page:Int,\$search:String,\$genre:[String],\$season:MediaSeason,\$year:Int,\$format:[MediaFormat],\$status:MediaStatus,\$country:CountryCode,\$score:Int,\$source:MediaSource,\$epsMin:Int,\$epsMax:Int,\$notIn:[Int],\$sort:[MediaSort])" +
        "{Page(page:\$page,perPage:30){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,search:\$search,genre_in:\$genre,season:\$season,seasonYear:\$year,format_in:\$format,status:\$status,countryOfOrigin:\$country,averageScore_greater:\$score,source:\$source,episodes_greater:\$epsMin,episodes_lesser:\$epsMax,id_not_in:\$notIn,sort:\$sort){$FIELDS}}}"

    /** One page of filtered results, and whether another page follows. */
    suspend fun search(vars: JSONObject): Pair<List<Media>, Boolean> {
        val page = graph(SEARCH, vars).optJSONObject("Page") ?: throw Exception("AniList didn't answer")
        val items = page.optJSONArray("media").objects().map(Media::parse)
        items.forEach { m -> if (!cache.containsKey(m.id)) cache[m.id] = m }
        return items to (page.optJSONObject("pageInfo")?.optBoolean("hasNextPage") ?: false)
    }

    suspend fun media(id: Int): Media {
        cache[id]?.takeIf { it.synopsis != null }?.let { return it }
        val q = "query(\$id:Int){Media(id:\$id,type:ANIME){$FIELDS}}"
        val o = graph(q, JSONObject().put("id", id)).optJSONObject("Media") ?: throw Exception("Couldn't load this show")
        return Media.parse(o).also { cache[id] = it }
    }

    /** Scores for posters that come from saved progress, which don't store one. */
    val ratings = androidx.compose.runtime.mutableStateMapOf<Int, String>()

    suspend fun loadRatings(ids: List<Int>) {
        val wanted = ids.distinct().filter { it !in ratings }.take(50)
        if (wanted.isEmpty()) return
        val q = "query(\$ids:[Int]){Page(perPage:50){media(id_in:\$ids,type:ANIME){id averageScore}}}"
        val found = runCatching { graph(q, JSONObject().put("ids", org.json.JSONArray(wanted))) }.getOrNull() ?: return
        found.optJSONObject("Page")?.optJSONArray("media").objects().forEach { m ->
            if (!m.isNull("averageScore")) ratings[m.optInt("id")] = String.format(java.util.Locale.US, "%.1f", m.optInt("averageScore") / 10.0)
        }
    }

    private val episodesFound = HashMap<Int, Map<Int, EpisodeInfo>>()

    /** Pictures, titles and lengths from ani.zip. Empty when it doesn't know the show. */
    suspend fun episodes(id: Int): Map<Int, EpisodeInfo> {
        episodesFound[id]?.let { return it }
        val r = runCatching { Net.get("https://api.ani.zip/mappings?anilist_id=$id") }.getOrNull()
        if (r == null || !r.ok) return emptyMap()
        val all = runCatching { JSONObject(r.body).optJSONObject("episodes") }.getOrNull() ?: return emptyMap()
        val found = HashMap<Int, EpisodeInfo>()
        all.keys().forEach { k ->
            val n = k.toIntOrNull() ?: return@forEach
            val e = all.optJSONObject(k) ?: return@forEach
            found[n] = EpisodeInfo(e.optJSONObject("title")?.str("en"), e.str("image"), e.int("runtime"), e.str("overview") ?: e.str("summary"), e.str("airDate"))
        }
        return found.also { episodesFound[id] = it }
    }

    class Upcoming(val media: Media, val episode: Int, val at: Long)

    /** Episodes of these shows due in the next seven days, soonest first. */
    suspend fun upcoming(ids: List<Int>): List<Upcoming> {
        if (ids.isEmpty()) return emptyList()
        val q = "query(\$ids:[Int],\$from:Int,\$to:Int){Page(perPage:50){airingSchedules(mediaId_in:\$ids,airingAt_greater:\$from,airingAt_lesser:\$to,sort:TIME){episode airingAt media{$FIELDS}}}}"
        val now = (System.currentTimeMillis() / 1000).toInt()
        val v = JSONObject().put("ids", JSONArray(ids)).put("from", now).put("to", now + 7 * 86400)
        return graph(q, v).optJSONObject("Page")?.optJSONArray("airingSchedules").objects().mapNotNull { row ->
            val m = row.optJSONObject("media") ?: return@mapNotNull null
            Upcoming(Media.parse(m), row.int("episode") ?: return@mapNotNull null, row.optLong("airingAt") * 1000)
        }
    }

    class Aired(val media: Media, val episode: Int)

    /** Episodes of these shows that aired in the last two weeks, newest first. */
    suspend fun recentlyAired(ids: List<Int>): List<Aired> {
        if (ids.isEmpty()) return emptyList()
        val q = "query(\$ids:[Int],\$from:Int,\$to:Int){Page(perPage:50){airingSchedules(mediaId_in:\$ids,airingAt_greater:\$from,airingAt_lesser:\$to,sort:TIME_DESC){episode media{$FIELDS}}}}"
        val now = (System.currentTimeMillis() / 1000).toInt()
        val v = JSONObject().put("ids", JSONArray(ids)).put("from", now - 14 * 86400).put("to", now)
        return graph(q, v).optJSONObject("Page")?.optJSONArray("airingSchedules").objects().mapNotNull { row ->
            val m = row.optJSONObject("media") ?: return@mapNotNull null
            Aired(Media.parse(m), row.int("episode") ?: return@mapNotNull null)
        }
    }

    suspend fun showIds(m: Media): ShowIds {
        val ids = ShowIds(anilist = m.id, mal = m.idMal)
        runCatching {
            val r = Net.get("https://arm.haglund.dev/api/v2/ids?source=anilist&id=${m.id}")
            if (r.ok) {
                val o = JSONObject(r.body)
                ids.kitsu = o.int("kitsu")
                ids.imdb = o.str("imdb")
                ids.imdbSeason = o.int("thetvdb-season") ?: o.int("themoviedb-season")
                ids.tmdb = o.int("themoviedb")
                ids.mal = o.int("myanimelist") ?: m.idMal
            }
        }
        return ids
    }

    /** Full HD art for a show, or null when there's none. */
    private val artFound = HashMap<Int, String?>()
    suspend fun art(context: android.content.Context, id: Int): String? {
        if (artFound.containsKey(id)) return artFound[id]
        val r = runCatching { Net.get("https://arm.haglund.dev/api/v2/ids?source=anilist&id=$id") }.getOrNull()
        if (r == null || !r.ok) return null
        val imdb = runCatching { JSONObject(r.body).str("imdb") }.getOrNull()
        val url = imdb?.let { "https://images.metahub.space/background/large/$it/img" }
        val worked = url != null && coil.Coil.imageLoader(context).execute(artRequest(context, url)) is coil.request.SuccessResult
        return (if (worked) url else null).also { artFound[id] = it }
    }

    /** One request shape, so the cached picture is the one that gets drawn. */
    fun artRequest(context: android.content.Context, url: String?) = coil.request.ImageRequest.Builder(context).data(url).size(1920, 1080).build()

    fun currentSeason(): Pair<String, Int> {
        val c = Calendar.getInstance()
        val month = c.get(Calendar.MONTH)
        val names = listOf("WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER")
        return names[month] to (c.get(Calendar.YEAR) + if (month == 11) 1 else 0)
    }
}
