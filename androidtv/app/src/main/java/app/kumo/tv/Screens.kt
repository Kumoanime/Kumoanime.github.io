package app.kumo.tv

import android.view.KeyEvent as NativeKey
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun routeId(route: String) = route.substringAfterLast('/').toIntOrNull()

class HomeRow(val key: String, val title: String, val items: List<Media>)

object HomeData {
    val rows = mutableStateListOf<HomeRow>()
    var error by mutableStateOf(false)
    val list = LazyListState()
    val rails = HashMap<String, LazyListState>()
    var tab by mutableIntStateOf(0)
    var focusedRow = 0
    val rowFocus = HashMap<Int, FocusRequester>()
    var aired by mutableStateOf<List<AniList.Aired>>(emptyList())

    suspend fun load() {
        if (rows.isNotEmpty()) return
        error = false
        val (season, year) = AniList.currentSeason()
        val pretty = season.lowercase().replaceFirstChar { it.uppercase() }
        runCatching {
            rows.add(HomeRow("trending", "Trending now", AniList.list("TRENDING_DESC", status = "RELEASING")))
            rows.add(HomeRow("season", "$pretty $year", AniList.list("POPULARITY_DESC", season = season, year = year)))
            rows.add(HomeRow("top", "All-time favourites", AniList.list("SCORE_DESC", status = "FINISHED")))
        }.onFailure { if (rows.isEmpty()) error = true }
    }
}

private val TabNames = listOf("Home", "Search", "Watching", "Add-ons", "Phone setup", "Account")

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TabsScreen() {
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.width(156.dp).fillMaxHeight().background(Color(0xFF0D0D10)).padding(horizontal = 12.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            KText("KUMO", 22, Orange, bold = true, modifier = Modifier.padding(start = 8.dp, bottom = 16.dp))
            TabNames.forEachIndexed { i, name ->
                Tile(Modifier.fillMaxWidth(), focusKey = "tab:$i", radius = 8.dp, grow = 1.02f, background = if (HomeData.tab == i) Raise else Color.Transparent, onFocused = { HomeData.tab = i }, onClick = {}) {
                    KText(name, 15, if (HomeData.tab == i) Color.White else Muted, modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp))
                }
            }
        }
        // Only Left leaves a tab's content. Up and Down stop at the edge of a list.
        Box(
            Modifier.weight(1f).fillMaxHeight().focusProperties {
                exit = { d -> if (d == FocusDirection.Up || d == FocusDirection.Down) FocusRequester.Cancel else FocusRequester.Default }
            }.focusGroup(),
        ) {
            when (HomeData.tab) {
                0 -> HomeScreen()
                1 -> SearchScreen()
                2 -> WatchingScreen()
                3 -> AddonsScreen()
                4 -> PhoneSetupScreen()
                else -> AccountScreen()
            }
        }
    }
    BackHandler(HomeData.tab != 0) { HomeData.tab = 0; Nav.restore = "tab:0" }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Rail(row: Int, key: String, title: String, items: List<PosterItem>) {
    val state = HomeData.rails.getOrPut(key) { LazyListState() }
    val focus = HomeData.rowFocus.getOrPut(row) { FocusRequester() }
    Column(Modifier.padding(bottom = 18.dp).onFocusChanged { if (it.hasFocus) HomeData.focusedRow = row }) {
        KText(title, 18, bold = true, modifier = Modifier.padding(start = 24.dp, bottom = 10.dp))
        LazyRow(Modifier.focusRequester(focus).focusRestorer(), state = state, contentPadding = PaddingValues(horizontal = 24.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(items, key = { it.key }) { Poster(it) }
        }
    }
}

@Composable
fun HomeScreen() {
    val context = LocalContext.current
    LaunchedEffect(Unit) { HomeData.load() }
    val v = Store.version
    val cont = remember(v) { Store.continueRows() }
    val watchIds = remember(v) { Store.watchingItems().mapNotNull { routeId(it.optString("route")) } }
    LaunchedEffect(watchIds) { runCatching { HomeData.aired = AniList.recentlyAired(watchIds) } }
    // The newest unwatched episode of each show in Watching.
    val fresh = remember(v, HomeData.aired) {
        HomeData.aired.filter { Store.percent(it.media.route, it.episode) <= 0.92f }.distinctBy { it.media.id }
    }
    if (HomeData.rows.isEmpty()) { Centered(if (HomeData.error) "Couldn't reach AniList. Check the connection." else "Loading…"); return }
    val firstKey = if (cont.isNotEmpty()) "continue:${cont[0].route}" else "home:first"
    LaunchedEffect(firstKey) { if (Nav.restore == "home:first") Nav.restore = firstKey }
    val freshRow = if (cont.isNotEmpty()) 1 else 0
    val firstListRow = freshRow + if (fresh.isNotEmpty()) 1 else 0
    val rowCount = HomeData.rows.size + firstListRow
    val scope = rememberCoroutineScope()
    // Row-to-row movement is handled here: left to itself, focus can leave the
    // list for the side menu when the next row isn't laid out yet.
    val rowKeys = Modifier.onPreviewKeyEvent { e ->
        val code = e.nativeKeyEvent.keyCode
        if (code != NativeKey.KEYCODE_DPAD_DOWN && code != NativeKey.KEYCODE_DPAD_UP) return@onPreviewKeyEvent false
        if (e.type == KeyEventType.KeyDown) {
            val target = HomeData.focusedRow + if (code == NativeKey.KEYCODE_DPAD_DOWN) 1 else -1
            if (target in 0 until rowCount) scope.launch {
                HomeData.list.scrollToItem(target)
                withFrameNanos { }
                runCatching { HomeData.rowFocus[target]?.requestFocus() }
            }
        }
        true
    }
    LazyColumn(rowKeys, state = HomeData.list, contentPadding = PaddingValues(top = 22.dp, bottom = 40.dp)) {
        if (cont.isNotEmpty()) item(key = "continue") {
            Rail(0, "continue", "Continue watching  ·  hold OK to remove", cont.mapNotNull { c ->
                val id = routeId(c.route) ?: return@mapNotNull null
                PosterItem("continue:${c.route}", id, c.title, c.poster, c.label, pct = c.pct, ep = c.ep ?: 1, onLong = {
                    confirm(context, "Remove ${c.title} from Continue watching?", "Remove") { Store.hideFromContinue(c.route); Nav.restore = "tab:0" }
                })
            })
        }
        if (fresh.isNotEmpty()) item(key = "fresh") {
            Rail(freshRow, "fresh", "New episodes", fresh.map { a ->
                PosterItem("fresh:${a.media.id}", a.media.id, a.media.title, a.media.cover, "Episode ${a.episode}", ep = a.episode)
            })
        }
        itemsIndexed(HomeData.rows, key = { _, r -> r.key }) { i, r ->
            Rail(i + firstListRow, r.key, r.title, r.items.mapIndexed { n, m -> m.poster(if (i == 0 && n == 0) "home:first" else "${r.key}:${m.id}") })
        }
    }
}

object SearchData {
    var query by mutableStateOf("")
    var results by mutableStateOf<List<Media>>(emptyList())
    var busy by mutableStateOf(false)
}

@Composable
fun SearchScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        KButton(if (SearchData.query.isEmpty()) "Type a title to search" else "Searching: ${SearchData.query}", focusKey = "search:box") {
            askText(context, "Search anime", SearchData.query) { q ->
                if (q.isEmpty()) return@askText
                SearchData.query = q; SearchData.busy = true
                scope.launch {
                    SearchData.results = runCatching { AniList.list("SEARCH_MATCH", search = q) }.getOrDefault(emptyList())
                    SearchData.busy = false
                }
            }
        }
        if (SearchData.busy) KText("Searching…", 14, Muted, modifier = Modifier.padding(top = 16.dp))
        else if (SearchData.query.isNotEmpty() && SearchData.results.isEmpty()) KText("Nothing found.", 14, Muted, modifier = Modifier.padding(top = 16.dp))
        LazyVerticalGrid(GridCells.Adaptive(PosterW + 14.dp), Modifier.padding(top = 14.dp), contentPadding = PaddingValues(6.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            items(SearchData.results, key = { it.id }) { Poster(it.poster("search:${it.id}")) }
        }
    }
}

@Composable
fun WatchingScreen() {
    val v = Store.version
    val list = remember(v) { Store.watchingItems() }
    if (list.isEmpty()) { Centered("Shows you add to Watching appear here."); return }
    LazyVerticalGrid(GridCells.Adaptive(PosterW + 14.dp), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(list, key = { it.optString("route") }) { o ->
            val id = routeId(o.optString("route")) ?: return@items
            Poster(PosterItem("watching:$id", id, o.str("title") ?: "", o.str("poster"), ""))
        }
    }
}

@Composable
fun AddonsScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val v = Store.addonVersion
    val list = remember(v) { Store.addons.toList() }
    LazyColumn(contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            KButton("Add an add-on link", focusKey = "addons:add", solid = true) {
                askText(context, "Paste or type the manifest link") { url ->
                    if (url.isEmpty()) return@askText
                    scope.launch {
                        runCatching { Addons.install(url) }
                            .onSuccess { a -> Store.addons.removeAll { it.url == a.url }; Store.addons.add(a); Store.saveAddons(); Toast.makeText(context, "Added ${a.name}", Toast.LENGTH_SHORT).show() }
                            .onFailure { Toast.makeText(context, it.message ?: "Couldn't add that", Toast.LENGTH_LONG).show() }
                    }
                }
            }
        }
        if (list.isEmpty()) item { KText("Add-ons supply the episodes Kumo can play.", 14, Muted, modifier = Modifier.padding(top = 8.dp)) }
        items(list, key = { it.url }) { a ->
            Tile(Modifier.fillMaxWidth(), radius = 8.dp, grow = 1.01f, background = Surface, onClick = {
                pick(context, a.name, listOf(if (a.enabled) "Turn off" else "Turn on", "Remove")) { i ->
                    if (i == 0) { a.enabled = !a.enabled; Store.saveAddons() }
                    else {
                        // Move focus first, or it falls back to the side menu and changes tab.
                        Nav.restore = "addons:add"
                        scope.launch { withFrameNanos { }; withFrameNanos { }; Store.addons.remove(a); Store.saveAddons() }
                    }
                }
            }) {
                Column(Modifier.padding(14.dp)) {
                    KText(a.name + if (a.enabled) "" else "  (off)", 16, bold = true, lines = 1)
                    KText(a.description, 13, Muted, lines = 2)
                }
            }
        }
    }
}

@Composable
fun AccountScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val version = Store.version
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val email = Store.accountEmail
        if (email != null) {
            KText(email, 18, bold = true)
            KText("Watching and progress sync with your phone. ${Store.syncState}", 14, Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                KButton("Sync now", focusKey = "acct:sync") { scope.launch { Store.sync() } }
                KButton("Log out") { Store.logout() }
            }
        } else {
            KText("Log in with your Kumo account to sync with your phone.", 15, Muted)
            KButton("Log in", focusKey = "acct:login", solid = true) {
                askText(context, "Email") { e ->
                    if (e.isEmpty()) return@askText
                    askText(context, "Password", password = true) { p ->
                        scope.launch {
                            runCatching { Store.login(e, p) }.onFailure { Toast.makeText(context, it.message ?: "Couldn't log in", Toast.LENGTH_LONG).show() }
                        }
                    }
                }
            }
        }
        KText("Playback", 16, bold = true, modifier = Modifier.padding(top = 12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            key(version) {
                Toggle("Auto Play", Store.autoPlay) { Store.autoPlay = !Store.autoPlay }
                Toggle("Auto Next", Store.autoNext) { Store.autoNext = !Store.autoNext }
                Toggle("Auto Skip", Store.autoSkip) { Store.autoSkip = !Store.autoSkip }
                Toggle(if (Store.prefer == Audio.DUB) "Audio: Dub" else "Audio: Sub", true) { Store.prefer = if (Store.prefer == Audio.DUB) Audio.SUB else Audio.DUB }
            }
        }
    }
}

@Composable
fun ShowScreen(id: Int) {
    val context = LocalContext.current
    var media by remember { mutableStateOf<Media?>(null) }
    var failed by remember { mutableStateOf(false) }
    var marking by remember { mutableStateOf(false) }
    LaunchedEffect(id) { runCatching { media = AniList.media(id) }.onFailure { failed = true } }
    val m = media ?: run { Centered(if (failed) "Couldn't load this show." else "Loading…"); return }
    val v = Store.version
    val count = m.episodeCount
    val next = remember(v) { Store.nextEpisode(m.route).coerceIn(1, maxOf(1, count)) }
    LaunchedEffect(m.id) { if (Nav.restore == null) Nav.restore = "show:play" }
    Box(Modifier.fillMaxSize()) {
        m.banner?.let { AsyncImage(it, null, Modifier.fillMaxWidth().height(260.dp).alpha(0.25f), contentScale = ContentScale.Crop) }
        Row(Modifier.fillMaxSize().padding(32.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            Column(Modifier.width(280.dp).fillMaxHeight()) {
                KText(m.title, 24, bold = true, lines = 3)
                KText(listOfNotNull(m.rating?.let { "★ $it" }, m.seasonYear?.toString(), m.format?.replace("_", " "), if (count > 0) "$count eps" else null).joinToString("  ·  "), 13, Muted, modifier = Modifier.padding(top = 6.dp))
                KText(m.synopsis ?: "", 13, Color(0xFFD5D5DB), lines = 9, modifier = Modifier.padding(top = 12.dp))
            }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (count > 0) KButton(if (m.isMovie) "Play" else "Play episode $next", focusKey = "show:play", solid = true) { Nav.push(Route.Watch(m.id, next, Store.autoPlay)) }
                    KButton(if (Store.inWatchlist(m.route)) "✓ Watching" else "+ Watching", focusKey = "show:list") { Store.toggleWatch(m.route, m.title, m.cover) }
                    if (!m.isMovie && count > 0) KButton(if (marking) "Done marking" else "Mark watched") { marking = !marking }
                }
                if (marking) KText("Press OK on an episode to mark it watched or unwatched.", 13, Orange, modifier = Modifier.padding(top = 10.dp))
                if (!m.isMovie) {
                    if (count == 0) KText("No episodes have aired yet.", 14, Muted, modifier = Modifier.padding(top = 16.dp))
                    LazyVerticalGrid(GridCells.Adaptive(62.dp), Modifier.padding(top = 14.dp), contentPadding = PaddingValues(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items((1..count).toList(), key = { it }) { n ->
                            val pct = Store.percent(m.route, n)
                            val seen = pct > 0.92f
                            Tile(Modifier.height(44.dp), focusKey = "ep:$n", radius = 8.dp, background = if (seen) Color(0xFF2B2015) else Surface, onClick = {
                                if (marking) Store.markWatched(m.route, n, !seen, m.title, m.cover)
                                else Nav.push(Route.Watch(m.id, n, Store.autoPlay))
                            }) {
                                KText((if (seen) "✓ " else "") + n, 14, if (seen) Orange else Color.White, modifier = Modifier.align(Alignment.Center))
                                if (pct > 0f && !seen) Bar(pct, Modifier.align(Alignment.BottomStart))
                            }
                        }
                    }
                }
            }
        }
    }
}

object LastFailure { var message by mutableStateOf<String?>(null) }

@Composable
fun WatchScreen(r: Route.Watch) {
    var media by remember { mutableStateOf<Media?>(null) }
    val rows = remember { mutableStateListOf<StreamRow>() }
    var extraSubs by remember { mutableStateOf<List<Subtitle>>(emptyList()) }
    var done by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var auto by remember { mutableStateOf(r.auto) }
    val start: (List<StreamRow>) -> Unit = { list ->
        media?.let { m -> if (list.isNotEmpty()) Nav.push(Route.Player(PlaySession(m, r.ep, list, extraSubs))) }
    }
    val prefer = Store.prefer
    LaunchedEffect(r.id, r.ep) {
        LastFailure.message = null
        val m = runCatching { AniList.media(r.id) }.getOrNull()
        if (m == null) { failed = true; return@LaunchedEffect }
        media = m
        val ids = AniList.showIds(m)
        launch { extraSubs = Addons.subtitles(Store.addons, ids, r.ep, m.isMovie) }
        Addons.streams(Store.addons, ids, r.ep, m.isMovie).collect { (addon, list) ->
            list.forEach { s -> rows.add(StreamRow(addon, s, StreamLogic.audio(s), rows.size)) }
        }
        done = true
    }
    // Start once every add-on answered, or after 4 seconds if a cached source is already here.
    LaunchedEffect(auto, media) {
        if (!auto || media == null) return@LaunchedEffect
        val began = System.currentTimeMillis()
        while (auto) {
            val cached = rows.any { StreamLogic.isCached(it.stream) }
            if (rows.isNotEmpty() && (done || (cached && System.currentTimeMillis() - began > 4000))) {
                auto = false
                start(StreamLogic.autoCandidates(rows.toList(), prefer))
                return@LaunchedEffect
            }
            if (done) return@LaunchedEffect
            delay(200)
        }
    }
    val m = media
    Column(Modifier.fillMaxSize().padding(32.dp)) {
        KText(m?.title ?: "Loading…", 22, bold = true, lines = 1)
        KText(if (m?.isMovie == true) "Movie" else "Episode ${r.ep}", 14, Muted, modifier = Modifier.padding(top = 2.dp, bottom = 12.dp))
        LastFailure.message?.let { KText(it, 14, Orange, modifier = Modifier.padding(bottom = 10.dp)) }
        when {
            failed -> KText("Couldn't load this episode.", 15, Muted)
            Store.addons.none { it.enabled } -> KText("Add an add-on first, in the Add-ons tab.", 15, Muted)
            rows.isEmpty() && done -> KText("No sources found for this episode.", 15, Muted)
            rows.isEmpty() -> KText("Asking your add-ons…", 15, Muted)
        }
        val ordered = remember(rows.size, done) { StreamLogic.order(rows.toList(), prefer) }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 6.dp)) {
            items(ordered, key = { it.index }) { row ->
                Tile(Modifier.fillMaxWidth(), focusKey = if (row === ordered.firstOrNull()) "src:first" else "src:${row.index}", radius = 8.dp, grow = 1.01f, background = Surface, onClick = {
                    auto = false
                    val tail = StreamLogic.autoCandidates(rows.toList(), prefer).filter { it !== row }
                    start(listOf(row) + tail)
                }) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                        val tag = if (row.audio == Audio.DUB) "DUB  " else if (row.audio == Audio.SUB) "SUB  " else ""
                        KText(tag + row.stream.label + "  ·  " + row.addon.name, 14, bold = true, lines = 1)
                        KText(row.stream.detail, 12, Muted, lines = 1)
                    }
                }
            }
        }
    }
    LaunchedEffect(rows.isNotEmpty(), auto) { if (rows.isNotEmpty() && !auto && Nav.restore == null) Nav.restore = "src:first" }
}
