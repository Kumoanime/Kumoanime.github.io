package app.kumo.tv

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.security.SecureRandom

enum class PairMode { LOGIN, ADDONS, ANILIST }

private fun html(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

/**
 * A small web form served by the TV to a phone on the same network, so details
 * never pass through another service. It runs only while its screen is open,
 * and every request has to carry the code from the QR link.
 */
class PairServer(private val token: String, private val mode: PairMode, private val report: (String) -> Unit) {
    private var socket: ServerSocket? = null
    private var badTries = 0
    @Volatile private var running = false

    fun start(): Boolean = runCatching {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(java.net.InetSocketAddress(PORT))
        socket = s
        running = true
        Thread {
            while (running) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                Thread { runCatching { c.use { handle(it) } } }.apply { isDaemon = true }.start()
            }
        }.apply { isDaemon = true }.start()
    }.isSuccess

    fun stop() { running = false; runCatching { socket?.close() } }

    private fun handle(c: Socket) {
        c.soTimeout = 15_000
        val input = BufferedInputStream(c.getInputStream())
        val head = ByteArrayOutputStream()
        while (head.size() < 8192) {
            val b = input.read()
            if (b < 0) return
            head.write(b)
            if (head.toString("ISO-8859-1").endsWith("\r\n\r\n")) break
        }
        val lines = head.toString("ISO-8859-1").split("\r\n")
        val parts = lines.first().split(" ")
        if (parts.size < 2) return
        val method = parts[0]
        val query = parts[1].substringAfter('?', "")
        val length = lines.firstOrNull { it.lowercase().startsWith("content-length:") }?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
        val body = ByteArray(length.coerceIn(0, MAX_BODY))
        var read = 0
        while (read < body.size) {
            val n = input.read(body, read, body.size - read)
            if (n < 0) break
            read += n
        }
        val form = if (method == "POST") parse(String(body, 0, read, Charsets.UTF_8)) else parse(query)
        if (badTries >= 20 || form["k"] != token) {
            badTries++
            send(c, 403, page("Scan the QR code on your TV again.", ""))
            return
        }
        val notes = if (method == "POST") submit(form) else emptyList()
        send(c, 200, page(notes.joinToString("<br>") { html(it) }, token))
    }

    private fun submit(form: Map<String, String>): List<String> = runBlocking {
        val notes = ArrayList<String>()
        val email = form["email"]?.trim().orEmpty()
        val password = form["password"].orEmpty()
        if (mode == PairMode.LOGIN && email.isNotEmpty() && password.isNotEmpty()) {
            val result = runCatching { withContext(Dispatchers.Main) { Store.login(email, password) } }
            notes.add(result.fold({ "Logged in as $email." }, { "Login failed: ${it.message}" }))
        }
        if (mode == PairMode.ADDONS) form["addons"].orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach { line ->
            val result = runCatching {
                val a = Addons.install(line)
                withContext(Dispatchers.Main) { Store.addons.removeAll { it.url == a.url }; Store.addons.add(a); Store.saveAddons() }
                a
            }
            notes.add(result.fold({ "Added ${it.name}." }, { "Couldn't add that link: ${it.message}" }))
        }
        val code = form["token"]?.trim().orEmpty()
        if (mode == PairMode.ANILIST && code.isNotEmpty()) {
            val result = runCatching { withContext(Dispatchers.Main) { AniListSync.link(code) } }
            notes.add(result.fold({ "Linked to $it on AniList." }, { "That code didn't work. Copy all of it and try again." }))
        }
        if (notes.isEmpty()) notes.add("Nothing to send yet.")
        notes.forEach(report)
        notes
    }

    private fun parse(s: String): Map<String, String> = s.split("&").filter { it.contains("=") }.associate {
        val k = it.substringBefore("=")
        k to runCatching { URLDecoder.decode(it.substringAfter("="), "UTF-8") }.getOrDefault("")
    }

    private fun send(c: Socket, code: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val status = if (code == 200) "200 OK" else "403 Forbidden"
        val head = "HTTP/1.1 $status\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        c.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
    }

    private fun fields() = if (mode == PairMode.ANILIST) """<h2>AniList</h2><p><a style="color:#ff8a1f" target="_blank" rel="noopener" href="${AniListSync.authorizeUrl}">1. Sign in to AniList and approve Kumo</a></p>
<label>2. Copy the code it shows, then paste it here<textarea name="token" rows="4" autocapitalize="none" autocorrect="off" spellcheck="false"></textarea></label>"""
    else if (mode == PairMode.LOGIN) """<h2>Kumo account</h2><label>Email<input name="email" type="email" autocomplete="username" autocapitalize="none"></label>
<label>Password<input name="password" type="password" autocomplete="current-password"></label>"""
    else """<h2>Add-ons</h2><label>Paste add-on links, one per line<textarea name="addons" rows="4" autocapitalize="none" autocorrect="off" spellcheck="false"></textarea></label>"""

    private fun page(note: String, k: String): String {
        val form = if (k.isEmpty()) "" else """
<form method="post" action="/"><input type="hidden" name="k" value="$k">
${fields()}
<button>Send to TV</button></form>"""
        return """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kumo TV setup</title>
<style>body{margin:0;padding:20px;background:#000;color:#fff;font:17px -apple-system,system-ui,sans-serif}h1{color:#ff8a1f;margin:0 0 4px}h2{font-size:18px;margin:24px 0 8px}
label{display:block;margin:10px 0;color:#bbb;font-size:15px}input:not([type=hidden]),textarea{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px;border:1px solid #444;border-radius:10px;background:#17171b;color:#fff;font-size:16px}
button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:10px;background:#ff8a1f;color:#000;font-size:17px;font-weight:700}.n{margin-top:14px;padding:12px;border-radius:10px;background:#26262c}</style></head>
<body><h1>KUMO</h1><div>TV setup</div>${if (note.isEmpty()) "" else "<div class=n>$note</div>"}$form</body></html>"""
    }

    companion object {
        const val PORT = 8722
        const val MAX_BODY = 32 * 1024

        fun newToken(): String {
            val letters = "abcdefghjkmnpqrstuvwxyz23456789"
            val r = SecureRandom()
            return (1..10).map { letters[r.nextInt(letters.length)] }.joinToString("")
        }

        fun address(): String? = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { it.isSiteLocalAddress }?.hostAddress
        }.getOrNull()
    }
}

private fun qrBitmap(text: String): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0)
    val b = Bitmap.createBitmap(m.width, m.height, Bitmap.Config.RGB_565)
    for (x in 0 until m.width) for (y in 0 until m.height) b.setPixel(x, y, if (m.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
    return b
}

/** A QR code for one job. The phone page it links to runs only while this is on screen. */
@Composable
fun PhoneQr(mode: PairMode, size: Dp, hint: String) {
    val token = remember { PairServer.newToken() }
    val ip = remember { PairServer.address() }
    val notes = remember { mutableStateListOf<String>() }
    var started by remember { mutableStateOf(true) }
    DisposableEffect(token) {
        val server = PairServer(token, mode) { line -> android.os.Handler(android.os.Looper.getMainLooper()).post { notes.add(0, line) } }
        started = server.start()
        onDispose { server.stop() }
    }
    if (ip == null || !started) { KText("The QR code needs this TV on your network.", 13, Muted); return }
    val url = "http://$ip:${PairServer.PORT}/?k=$token"
    val qr = remember(url) { qrBitmap(url).asImageBitmap() }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(size).background(Color.White)) {
            Image(qr, "QR code", Modifier.fillMaxSize(), contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
        }
        KText(hint, 12, Muted)
        notes.take(3).forEach { KText(it, 12, Orange, bold = true) }
    }
}
