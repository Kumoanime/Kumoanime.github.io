package app.kumo.tv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Sends progress one way, from Kumo to the linked AniList account. It only ever
 * moves an entry forward, and what can't be sent waits in a queue for next time.
 */
object AniListSync {
    /** From anilist.co/settings/developer. Linking stays hidden until this is set. */
    const val CLIENT_ID = 0
    val authorizeUrl get() = "https://anilist.co/api/v2/oauth/authorize?client_id=$CLIENT_ID&response_type=token"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private fun auth(token: String) = mapOf("Authorization" to "Bearer $token")

    suspend fun link(token: String): String {
        val clean = token.substringAfter("access_token=").substringBefore('&').trim()
        val name = AniList.graph("{Viewer{name}}", JSONObject(), auth(clean)).optJSONObject("Viewer")?.str("name") ?: throw Exception("AniList didn't accept that code")
        Store.setAniList(clean, name)
        return name
    }

    /** Episode 0 means the show was only added to Watching. */
    fun queue(id: Int, ep: Int) {
        if (Store.aniListName == null) return
        Store.queueAniList("$id:$ep")
        flush()
    }

    fun flush() {
        val token = Store.aniListToken ?: return
        scope.launch {
            for (item in Store.aniListQueue()) {
                val id = item.substringBefore(':').toIntOrNull() ?: continue
                val ep = item.substringAfter(':').toIntOrNull() ?: continue
                if (runCatching { send(token, id, ep) }.isSuccess) Store.unqueueAniList(item) else break
            }
        }
    }

    private suspend fun send(token: String, id: Int, ep: Int) {
        val headers = auth(token)
        val entry = AniList.graph("query(\$id:Int){Media(id:\$id){mediaListEntry{progress}}}", JSONObject().put("id", id), headers)
            .optJSONObject("Media")?.optJSONObject("mediaListEntry")
        if (entry != null && ep <= entry.optInt("progress")) return
        val m = AniList.media(id)
        val done = ep > 0 && m.status == "FINISHED" && ep >= (m.episodes ?: if (m.isMovie) 1 else Int.MAX_VALUE)
        val vars = JSONObject().put("id", id).put("status", if (done) "COMPLETED" else "CURRENT")
        if (ep > 0) vars.put("progress", ep)
        AniList.graph("mutation(\$id:Int,\$status:MediaListStatus,\$progress:Int){SaveMediaListEntry(mediaId:\$id,status:\$status,progress:\$progress){id}}", vars, headers)
    }
}
