package app.kumo.tv

import org.json.JSONArray
import org.json.JSONObject

/** Which episodes of a show are filler, from community lists. Empty when nobody lists the show. */
object Filler {
    private val found = HashMap<Int, Set<Int>>()
    private var index: String? = null

    private fun numbers(list: JSONArray?, number: String, kind: String): Set<Int> =
        list.objects().filter { it.str(kind) == "filler" }.mapNotNull { it.int(number) }.filter { it > 0 }.toSet()

    private suspend fun pedia(mal: Int): Set<Int>? {
        val r = Net.get("https://anifillerpedia.wiki/api/v1/series?mal_id=$mal")
        if (!r.ok) return null
        val series = JSONObject(r.body).optJSONArray("items")?.optJSONObject(0)?.int("id") ?: return null
        val e = Net.get("https://anifillerpedia.wiki/api/v1/series/$series/episodes")
        return if (e.ok) numbers(JSONArray(e.body), "episode_number", "status") else null
    }

    private suspend fun anira(mal: Int): Set<Int>? {
        val list = index ?: Net.get("https://raw.githubusercontent.com/AniraTeam/AniFiller/main/README.md").takeIf { it.ok }?.body?.also { index = it } ?: return null
        val file = Regex("\\|\\s*\\[`([^`]+\\.json)`\\][^|\\n]*\\|\\s*[^|\\n]+\\|\\s*$mal\\s*\\|").find(list)?.groupValues?.get(1) ?: return null
        val r = Net.get("https://cdn.jsdelivr.net/gh/AniraTeam/AniFiller@main/data/shows/$file")
        return if (r.ok) numbers(JSONObject(r.body).optJSONArray("episodes"), "episode", "type") else null
    }

    suspend fun episodes(mal: Int?): Set<Int> {
        if (mal == null) return emptySet()
        found[mal]?.let { return it }
        val list = runCatching { pedia(mal) }.getOrNull() ?: runCatching { anira(mal) }.getOrNull() ?: emptySet()
        return list.also { found[mal] = it }
    }
}
