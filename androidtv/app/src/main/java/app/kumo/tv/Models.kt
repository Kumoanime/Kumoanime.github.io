package app.kumo.tv

import org.json.JSONArray
import org.json.JSONObject

fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }
fun JSONObject.int(key: String): Int? = if (isNull(key) || !has(key)) null else opt(key).let { (it as? Number)?.toInt() ?: it.toString().toIntOrNull() }
fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { opt(it) as? String }

data class Media(
    val id: Int,
    val idMal: Int?,
    val title: String,
    val cover: String?,
    val banner: String?,
    val format: String?,
    val status: String?,
    val episodes: Int?,
    val seasonYear: Int?,
    val score: Int?,
    val genres: List<String>,
    val synopsis: String?,
    val nextEpisode: Int?,
) {
    val route get() = "#/a/$id"
    val isMovie get() = format == "MOVIE"
    val rating get() = score?.let { String.format(java.util.Locale.US, "%.1f", it / 10.0) }
    val episodeCount: Int
        get() = when {
            isMovie -> if (status == "NOT_YET_RELEASED") 0 else 1
            nextEpisode != null -> maxOf(0, nextEpisode - 1)
            status == "NOT_YET_RELEASED" -> 0
            else -> episodes ?: 12
        }

    companion object {
        fun parse(o: JSONObject): Media {
            val title = o.optJSONObject("title")
            return Media(
                id = o.optInt("id"),
                idMal = o.int("idMal"),
                title = title?.str("english") ?: title?.str("romaji") ?: "Untitled",
                cover = o.optJSONObject("coverImage")?.str("large"),
                banner = o.str("bannerImage"),
                format = o.str("format"),
                status = o.str("status"),
                episodes = o.int("episodes"),
                seasonYear = o.int("seasonYear"),
                score = o.int("averageScore"),
                genres = o.optJSONArray("genres").strings(),
                synopsis = o.str("description")?.let(::stripHtml),
                nextEpisode = o.optJSONObject("nextAiringEpisode")?.int("episode"),
            )
        }
    }
}

fun stripHtml(raw: String): String = raw
    .replace(Regex("(?i)<br\\s*/?>"), "\n")
    .replace(Regex("<[^>]+>"), "")
    .replace(Regex("\n{3,}"), "\n\n")
    .trim()

data class ShowIds(
    val anilist: Int,
    var mal: Int? = null,
    var kitsu: Int? = null,
    var imdb: String? = null,
    var imdbSeason: Int? = null,
    var tmdb: Int? = null,
)

data class Subtitle(val url: String, val lang: String)

data class Stream(
    val name: String?,
    val title: String?,
    val description: String?,
    val url: String?,
    val filename: String?,
    val subtitles: List<Subtitle>,
) {
    val label get() = name?.replace("\n", " ") ?: "Source"
    val detail get() = (title ?: description ?: filename ?: "").replace("\n", " · ")

    companion object {
        fun parse(o: JSONObject) = Stream(
            name = o.str("name"),
            title = o.str("title"),
            description = o.str("description"),
            url = o.str("url"),
            filename = o.optJSONObject("behaviorHints")?.str("filename"),
            subtitles = o.optJSONArray("subtitles").objects().mapNotNull { s ->
                s.str("url")?.let { Subtitle(it, s.str("lang") ?: "") }
            },
        )
    }
}

enum class Audio { SUB, DUB, OTHER }

data class StreamRow(val addon: Addon, val stream: Stream, val audio: Audio, val index: Int)

class Addon(val url: String, val manifest: JSONObject, var enabled: Boolean = true) {
    val name get() = manifest.str("name") ?: "Add-on"
    val description get() = manifest.str("description") ?: ""
    private val types get() = manifest.optJSONArray("types").strings()
    private val prefixes: List<String>? get() = if (manifest.has("idPrefixes")) manifest.optJSONArray("idPrefixes").strings() else null

    /** The types and id prefixes one resource accepts, or null when the add-on doesn't offer it. */
    fun spec(resource: String): Pair<List<String>, List<String>?>? {
        val list = manifest.optJSONArray("resources") ?: return null
        for (i in 0 until list.length()) {
            when (val item = list.opt(i)) {
                is String -> if (item == resource) return types to prefixes
                is JSONObject -> if (item.str("name") == resource) {
                    val t = if (item.has("types")) item.optJSONArray("types").strings() else types
                    val p = if (item.has("idPrefixes")) item.optJSONArray("idPrefixes").strings() else prefixes
                    return t to p
                }
            }
        }
        return null
    }

    fun handles(resource: String, id: String): Boolean {
        val prefixList = (spec(resource) ?: return false).second ?: return true
        return prefixList.any { id.startsWith(it) }
    }

    fun toJson(): JSONObject = JSONObject().put("url", url).put("manifest", manifest).put("enabled", enabled)
}
