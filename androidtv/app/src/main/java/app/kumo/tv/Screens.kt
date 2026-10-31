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
import androidx.compose.foundation.layout.size
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
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
    var focusedRow by mutableIntStateOf(0)
    val contentFocus = FocusRequester()
    val accountFocus = FocusRequester()
    val dockFocus = List(4) { FocusRequester() }
    val rowKeys = HashMap<Int, List<String>>()
    val rowStates = HashMap<Int, LazyListState>()
    var moving = false
    var aired by mutableStateOf<List<AniList.Aired>>(emptyList())
    var heroTarget by mutableStateOf<Hero?>(null)

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

private val Tabs = listOf(
    "Home" to Icons.Filled.Home, "Search" to Icons.Filled.Search,
    "Watching" to Icons.Filled.Favorite, "Settings" to Icons.Filled.Settings,
)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TabsScreen() {
    var open by remember { mutableStateOf(false) }
    val content = HomeData.contentFocus
    val dock = HomeData.dockFocus
    val scope = rememberCoroutineScope()
    Box(Modifier.fillMaxSize()) {
        // The dock floats over the page, so only Left and Up leave the page,
        // always for the current tab or the account button. Right and Down stop
        // at the edge, so a short row can't send focus to the account button.
        Box(
            Modifier.fillMaxSize().focusRequester(content).focusProperties {
                exit = { d ->
                    when (d) {
                        FocusDirection.Left -> dock[HomeData.tab]
                        FocusDirection.Up -> HomeData.accountFocus
                        else -> FocusRequester.Cancel
                    }
                }
            }.focusRestorer().focusGroup(),
        ) {
            when (HomeData.tab) {
                0 -> HomeScreen()
                1 -> SearchScreen()
                2 -> WatchingScreen()
                else -> SettingsScreen()
            }
        }
        Column(
            Modifier.align(Alignment.CenterStart).padding(start = 14.dp).width(if (open) 164.dp else 48.dp)
                .graphicsLayer { alpha = if (open) 1f else 0f }
                .onFocusChanged { open = it.hasFocus }
                .onPreviewKeyEvent { e ->
                    if (e.nativeKeyEvent.keyCode != NativeKey.KEYCODE_DPAD_RIGHT) return@onPreviewKeyEvent false
                    if (e.type == KeyEventType.KeyDown) runCatching { content.requestFocus() }
                    true
                }
                .background(Color(0xF216161C), RoundedCornerShape(30.dp)).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Tabs.forEachIndexed { i, (name, icon) ->
                val selected = HomeData.tab == i
                Tile(Modifier.fillMaxWidth(), focusKey = "tab:$i", requester = dock[i], radius = 22.dp, grow = 1f, outline = false, focusedBackground = Color.White, onFocused = {
                    // OK never moves into the dock, so if the pressed item vanished
                    // focus stays on this page instead of switching tab.
                    if (Nav.lastKey == NativeKey.KEYCODE_DPAD_CENTER || Nav.lastKey == NativeKey.KEYCODE_ENTER) scope.launch { runCatching { content.requestFocus() } }
                    else HomeData.tab = i
                }, onClick = { runCatching { content.requestFocus() } }) { f ->
                    val tint = if (f) Color.Black else if (selected) Orange else Muted
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(icon, name, Modifier.size(20.dp), tint = tint)
                        KText(name, 14, tint, bold = f, lines = 1)
                    }
                }
            }
        }
        Tile(
            Modifier.align(Alignment.TopEnd).padding(top = 18.dp, end = 24.dp).size(42.dp)
                .focusProperties { down = content; left = content },
            requester = HomeData.accountFocus, radius = 21.dp, grow = 1.08f, outline = false,
            background = Color(0x99202026), focusedBackground = Color.White, onClick = { Nav.push(Route.Account) },
        ) { f ->
            Icon(Icons.Filled.Person, "Account", Modifier.align(Alignment.Center).size(22.dp), tint = if (f) Color.Black else Color.White)
        }
    }
    // The dock is hidden, so Back brings it up. Back again goes Home, then exits.
    BackHandler(!open || HomeData.tab != 0) {
        if (!open) runCatching { dock[HomeData.tab].requestFocus() }
        else { HomeData.tab = 0; runCatching { dock[0].requestFocus() } }
    }
}

@Composable
private fun Rail(row: Int, key: String, title: String, items: List<PosterItem>) {
    val state = HomeData.rails.getOrPut(key) { LazyListState() }
    HomeData.rowKeys[row] = items.map { it.key }
    HomeData.rowStates[row] = state
    Column(Modifier.padding(bottom = 14.dp).onFocusChanged { if (it.hasFocus) HomeData.focusedRow = row }) {
        KText(title, 15, bold = true, modifier = Modifier.padding(start = 28.dp, bottom = 6.dp))
        LazyRow(state = state, contentPadding = PaddingValues(horizontal = 28.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
    val freshRow = if (cont.isNotEmpty()) 1 else 0
    val firstListRow = freshRow + if (fresh.isNotEmpty()) 1 else 0
    val rowCount = HomeData.rows.size + firstListRow
    // Every row lines up under the preview, however focus arrived, so none is left cropped.
    LaunchedEffect(HomeData.focusedRow) { delay(60); HomeData.list.scrollToItem(HomeData.focusedRow) }
    val scope = rememberCoroutineScope()
    // Row-to-row movement is handled here: left to itself, focus can leave the
    // list for the side menu when the next row isn't laid out yet.
    val rowKeys = Modifier.onPreviewKeyEvent { e ->
        val code = e.nativeKeyEvent.keyCode
        if (code != NativeKey.KEYCODE_DPAD_DOWN && code != NativeKey.KEYCODE_DPAD_UP) return@onPreviewKeyEvent false
        if (e.type == KeyEventType.KeyDown) {
            val target = HomeData.focusedRow + if (code == NativeKey.KEYCODE_DPAD_DOWN) 1 else -1
            if (target < 0) runCatching { HomeData.accountFocus.requestFocus() }
            else if (target < rowCount && !HomeData.moving) {
                HomeData.moving = true
                // Land on the poster directly above or below, not a remembered one.
                val from = HomeData.focusedRow
                val column = (HomeData.rowKeys[from]?.indexOf(Nav.lastFocus) ?: 0).coerceAtLeast(0) - (HomeData.rowStates[from]?.firstVisibleItemIndex ?: 0)
                scope.launch {
                    HomeData.list.scrollToItem(target)
                    withFrameNanos { }
                    val keys = HomeData.rowKeys[target].orEmpty()
                    val first = HomeData.rowStates[target]?.firstVisibleItemIndex ?: 0
                    if (keys.isNotEmpty()) Nav.restore = keys[(first + column).coerceIn(0, keys.lastIndex)]
                    HomeData.moving = false
                }
            }
        }
        true
    }
    val hero = HomeData.heroTarget ?: HomeData.rows.first().items.firstOrNull()?.hero()
    var shown by remember { mutableStateOf(hero) }
    // A short wait so holding an arrow key doesn't load every banner on the way.
    LaunchedEffect(hero) { delay(220); shown = hero }
    Box(Modifier.fillMaxSize()) {
    shown?.let { Backdrop(it.image, 0.75f) }
    Column(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxWidth(0.62f).height(196.dp).padding(start = 28.dp, top = 26.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        shown?.let {
            KText(it.title, 28, bold = true, lines = 2)
            KText(it.meta, 13, Color(0xFFE2E2E8), lines = 1)
            KText(it.text ?: "", 13, Muted, lines = 3)
        }
    }
    LaunchedEffect(cont.size) { AniList.loadRatings(cont.mapNotNull { routeId(it.route) }) }
    LazyColumn(rowKeys.weight(1f), state = HomeData.list, contentPadding = PaddingValues(bottom = 220.dp)) {
        if (cont.isNotEmpty()) item(key = "continue") {
            Rail(0, "continue", "Continue watching", cont.mapNotNull { c ->
                val id = routeId(c.route) ?: return@mapNotNull null
                PosterItem(if (c === cont.first()) "home:first" else "continue:${c.route}", id, c.title, c.poster, c.label, pct = c.pct, ep = c.ep ?: 1, hero = Hero(c.title, c.poster, c.label, null), onRemove = { Store.hideFromContinue(c.route); Nav.restore = "home:first" })
            })
        }
        if (fresh.isNotEmpty()) item(key = "fresh") {
            Rail(freshRow, "fresh", "New episodes", fresh.map { a ->
                PosterItem(if (cont.isEmpty() && a === fresh.first()) "home:first" else "fresh:${a.media.id}", a.media.id, a.media.title, a.media.cover, "Episode ${a.episode}", rating = a.media.rating, ep = a.episode, hero = a.media.hero())
            })
        }
        itemsIndexed(HomeData.rows, key = { _, r -> r.key }) { i, r ->
            Rail(i + firstListRow, r.key, r.title, r.items.mapIndexed { n, m -> m.poster(if (firstListRow == 0 && i == 0 && n == 0) "home:first" else "${r.key}:${m.id}") })
        }
    }
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
    Column(Modifier.fillMaxSize().padding(start = 40.dp, end = 80.dp, top = 28.dp)) {
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
    LaunchedEffect(list.size) { AniList.loadRatings(list.mapNotNull { routeId(it.optString("route")) }) }
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
    LaunchedEffect(Unit) { if (Nav.restore == null) Nav.restore = "addons:add" }
    LazyColumn(contentPadding = PaddingValues(40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { KText("Add-ons", 26, bold = true, modifier = Modifier.padding(bottom = 6.dp)) }
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
fun SettingsScreen() {
    Store.version  // Redraws the toggles when a setting changes.
    val addonCount = Store.addonVersion.let { Store.addons.size }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, end = 80.dp, top = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        KText("Settings", 26, bold = true)
        KText("Playback", 15, Muted, bold = true, modifier = Modifier.padding(top = 14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Toggle("Auto Next", Store.autoNext, "set:next") { Store.autoNext = !Store.autoNext }
            Toggle("Auto Skip", Store.autoSkip, "set:skip") { Store.autoSkip = !Store.autoSkip }
            Toggle(if (Store.prefer == Audio.DUB) "Audio: Dub" else "Audio: Sub", true, "set:audio") { Store.prefer = if (Store.prefer == Audio.DUB) Audio.SUB else Audio.DUB }
        }
        KText("Add-ons and devices", 15, Muted, bold = true, modifier = Modifier.padding(top = 18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            KButton(if (addonCount == 1) "Add-ons  ·  1 installed" else "Add-ons  ·  $addonCount installed", focusKey = "set:addons") { Nav.push(Route.Addons) }
            KButton("Phone setup", focusKey = "set:phone") { Nav.push(Route.PhoneSetup) }
        }
    }
}

@Composable
fun AccountScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val email = Store.accountEmail
    LaunchedEffect(email) { if (Nav.restore == null) Nav.restore = if (email != null) "acct:sync" else "acct:login" }
    Column(Modifier.fillMaxSize().padding(40.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        KText("Account", 26, bold = true)
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
    }
}

/** Dimmed show art behind the whole screen. */
@Composable
private fun Backdrop(m: Media) = Backdrop(m.banner ?: m.cover, 0.55f)

@Composable
private fun Backdrop(image: String?, strength: Float) {
    if (image == null) return
    AsyncImage(image, null, Modifier.fillMaxSize().alpha(strength), contentScale = ContentScale.Crop)
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Color.Black, 0.7f to Color(0x66000000), 1f to Color.Transparent)))
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.25f to Color.Transparent, 0.85f to Color.Black)))
}

@Composable
private fun SourceColumn(title: String, list: List<StreamRow>, state: LazyListState, keyOf: (StreamRow) -> String, modifier: Modifier, onPick: (StreamRow) -> Unit) {
    Column(modifier) {
        KText("$title  ·  ${list.size}", 16, Orange, bold = true, modifier = Modifier.padding(start = 6.dp, bottom = 6.dp))
        LazyColumn(state = state, verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(6.dp)) {
            items(list, key = { it.index }) { row ->
                Tile(Modifier.fillMaxWidth(), focusKey = keyOf(row), radius = 8.dp, grow = 1.02f, background = Surface, onClick = { onPick(row) }) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        KText(row.stream.label, 13, bold = true, lines = 1)
                        KText(row.stream.detail.ifEmpty { row.addon.name }, 11, Muted, lines = 3)
                    }
                }
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
        Backdrop(m)
        Row(Modifier.fillMaxSize().padding(32.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            Column(Modifier.width(280.dp).fillMaxHeight()) {
                KText(m.title, 30, bold = true, lines = 3)
                KText(listOfNotNull(m.rating?.let { "★ $it" }, m.seasonYear?.toString(), m.format?.replace("_", " "), if (count > 0) "$count eps" else null).joinToString("  ·  "), 13, Muted, modifier = Modifier.padding(top = 6.dp))
                KText(m.synopsis ?: "", 13, Color(0xFFD5D5DB), lines = 9, modifier = Modifier.padding(top = 12.dp))
            }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (count > 0) KButton(if (m.isMovie) "Play" else "Play episode $next", focusKey = "show:play", solid = true) { Nav.push(Route.Watch(m.id, next, false)) }
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
                            Tile(Modifier.height(44.dp), focusKey = "ep:$n", radius = 12.dp, outline = false, background = if (seen) Color(0x33FF8A1F) else Surface, focusedBackground = Color.White, onClick = {
                                if (marking) Store.markWatched(m.route, n, !seen, m.title, m.cover)
                                else Nav.push(Route.Watch(m.id, n, false))
                            }) { f ->
                                KText((if (seen) "✓ " else "") + n, 14, if (f) Color.Black else if (seen) Orange else Color.White, bold = true, modifier = Modifier.align(Alignment.Center))
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
    var showIds by remember { mutableStateOf<ShowIds?>(null) }
    var done by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var auto by remember { mutableStateOf(r.auto) }
    val start: (List<StreamRow>) -> Unit = { list ->
        val m = media
        val ids = showIds
        if (m != null && ids != null && list.isNotEmpty()) Nav.push(Route.Player(PlaySession(m, r.ep, list, extraSubs, ids)))
    }
    val prefer = Store.prefer
    LaunchedEffect(r.id, r.ep) {
        LastFailure.message = null
        val m = runCatching { AniList.media(r.id) }.getOrNull()
        if (m == null) { failed = true; return@LaunchedEffect }
        media = m
        val ids = AniList.showIds(m)
        showIds = ids
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
    Box(Modifier.fillMaxSize()) {
        m?.let { Backdrop(it) }
        Column(Modifier.fillMaxSize().padding(start = 32.dp, end = 32.dp, top = 24.dp)) {
            KText(m?.title ?: "Loading…", 22, bold = true, lines = 1)
            KText(if (m?.isMovie == true) "Movie" else "Episode ${r.ep}", 14, Muted, modifier = Modifier.padding(top = 2.dp, bottom = 12.dp))
            LastFailure.message?.let { KText(it, 14, Orange, modifier = Modifier.padding(bottom = 10.dp)) }
            when {
                failed -> KText("Couldn't load this episode.", 15, Muted)
                Store.addons.none { it.enabled } -> KText("Add an add-on first, in Settings.", 15, Muted)
                rows.isEmpty() && done -> KText("No sources found for this episode.", 15, Muted)
                rows.isEmpty() -> KText("Asking your add-ons…", 15, Muted)
            }
            val ordered = remember(rows.size, done) { StreamLogic.order(rows.toList(), prefer) }
            val groups = remember(ordered) {
                val other = if (ordered.any { it.audio != Audio.OTHER }) "Other" else "Sources"
                val names = if (prefer == Audio.DUB) listOf(Audio.DUB to "DUB", Audio.SUB to "SUB", Audio.OTHER to other)
                else listOf(Audio.SUB to "SUB", Audio.DUB to "DUB", Audio.OTHER to other)
                names.map { (kind, name) -> name to ordered.filter { it.audio == kind } }.filter { it.second.isNotEmpty() }
            }
            val states = remember { List(3) { LazyListState() } }
            val scope = rememberCoroutineScope()
            val keyOf = { row: StreamRow -> if (row === groups.firstOrNull()?.second?.firstOrNull()) "src:first" else "src:${row.index}" }
            // Columns scroll on their own, so Left and Right line the next column
            // up with this one and land on the source at the same height.
            val sideways = Modifier.onPreviewKeyEvent { e ->
                val code = e.nativeKeyEvent.keyCode
                val step = when (code) {
                    android.view.KeyEvent.KEYCODE_DPAD_LEFT -> -1
                    android.view.KeyEvent.KEYCODE_DPAD_RIGHT -> 1
                    else -> 0
                }
                val column = groups.indexOfFirst { g -> g.second.any { keyOf(it) == Nav.lastFocus } }
                val target = column + step
                if (step == 0 || column < 0) return@onPreviewKeyEvent false
                if (target !in groups.indices) return@onPreviewKeyEvent target >= 0
                if (e.type == KeyEventType.KeyDown) {
                    val index = groups[column].second.indexOfFirst { keyOf(it) == Nav.lastFocus }
                    val next = groups[target].second
                    val here = states[column]
                    scope.launch {
                        states[target].scrollToItem(here.firstVisibleItemIndex.coerceAtMost(next.lastIndex), here.firstVisibleItemScrollOffset)
                        withFrameNanos { }
                        Nav.restore = keyOf(next[index.coerceAtMost(next.lastIndex)])
                    }
                }
                true
            }
            Row(Modifier.fillMaxSize().then(sideways), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                groups.forEachIndexed { i, (name, list) ->
                    SourceColumn(name, list, states[i], keyOf, Modifier.weight(1f).fillMaxHeight()) { row ->
                        auto = false
                        // If it fails, fall back to sources of the same kind first.
                        val kind = if (row.audio == Audio.DUB) Audio.DUB else prefer
                        start(listOf(row) + StreamLogic.autoCandidates(rows.toList(), kind).filter { it !== row })
                    }
                }
            }
        }
    }
    LaunchedEffect(rows.isNotEmpty(), auto) { if (rows.isNotEmpty() && !auto && Nav.restore == null) Nav.restore = "src:first" }
}
