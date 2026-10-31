package app.kumo.tv

import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

object AniList {
    private const val FIELDS = "id idMal title{romaji english} coverImage{large} bannerImage format status episodes seasonYear averageScore genres description(asHtml:false) nextAiringEpisode{episode airingAt}"
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

    suspend fun media(id: Int): Media {
        cache[id]?.takeIf { it.synopsis != null }?.let { return it }
        val q = "query(\$id:Int){Media(id:\$id,type:ANIME){$FIELDS}}"
        val o = graph(q, JSONObject().put("id", id)).optJSONObject("Media") ?: throw Exception("Couldn't load this show")
        return Media.parse(o).also { cache[id] = it }
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

    fun currentSeason(): Pair<String, Int> {
        val c = Calendar.getInstance()
        val month = c.get(Calendar.MONTH)
        val names = listOf("WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER")
        return names[month] to (c.get(Calendar.YEAR) + if (month == 11) 1 else 0)
    }
}
