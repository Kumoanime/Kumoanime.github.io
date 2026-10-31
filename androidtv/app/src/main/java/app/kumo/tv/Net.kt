package app.kumo.tv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class HttpResult(val code: Int, val body: String) { val ok get() = code in 200..299 }

object Net {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json".toMediaType()

    suspend fun get(url: String, headers: Map<String, String> = emptyMap()): HttpResult =
        send(Request.Builder().url(url), headers)

    suspend fun post(url: String, json: String, headers: Map<String, String> = emptyMap()): HttpResult =
        send(Request.Builder().url(url).post(json.toRequestBody(JSON)), headers)

    private suspend fun send(builder: Request.Builder, headers: Map<String, String>): HttpResult =
        withContext(Dispatchers.IO) {
            builder.header("User-Agent", "Kumo/1.0 (Android TV)").header("Accept", "application/json")
            headers.forEach { (k, v) -> builder.header(k, v) }
            client.newCall(builder.build()).execute().use { HttpResult(it.code, it.body?.string() ?: "") }
        }
}
