package app.kumo.tv

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.unit.Dp
import org.json.JSONArray
import org.json.JSONObject
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.ui.draw.clip
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
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
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
    val v = Store.version
    val watchIds = remember(v) { Store.watchingItems().mapNotNull { routeId(it.optString("route")) } }
    LaunchedEffect(watchIds) {
        while (true) {
            runCatching { HomeData.aired = AniList.recentlyAired(watchIds) }
            delay(30 * 60_000L)
        }
    }
    // The newest unwatched episode of each show in Watching.
    val fresh = remember(v, HomeData.aired, watchIds) {
        HomeData.aired.filter { it.media.id in watchIds && Store.percent(it.media.route, it.episode) <= 0.92f }.distinctBy { it.media.id }
            .filter { !Store.newsCleared(it.media.id, it.episode) }
    }
    val bell = remember { FocusRequester() }
    val firstNews = remember { FocusRequester() }
    var news by remember { mutableStateOf(false) }
    // Focus moves first, or closing the panel would leave it with nowhere to go.
    val closeNews = { runCatching { bell.requestFocus() }; news = false }
    val context = LocalContext.current
    val firstAccount = remember { FocusRequester() }
    var account by remember { mutableStateOf(false) }
    val closeAccount = { runCatching { HomeData.accountFocus.requestFocus() }; account = false }
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
                        FocusDirection.Right, FocusDirection.Down -> FocusRequester.Cancel
                        // Anything else is the app moving focus itself, which must get through.
                        else -> FocusRequester.Default
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
                .focusProperties { down = content; left = bell },
            focusKey = "account", requester = HomeData.accountFocus, radius = 21.dp, grow = 1.08f, outline = false,
            background = Color(0x99202026), focusedBackground = Color.White, onClick = { account = true },
        ) { f ->
            Icon(Icons.Filled.Person, "Account", Modifier.align(Alignment.Center).size(22.dp), tint = if (f) Color.Black else Color.White)
        }
        Box(Modifier.align(Alignment.TopEnd).padding(top = 18.dp, end = 76.dp).size(42.dp)) {
            Tile(
                Modifier.fillMaxSize().focusProperties { down = content; right = HomeData.accountFocus; left = dock[HomeData.tab] },
                focusKey = "bell", requester = bell, radius = 21.dp, grow = 1.08f, outline = false,
                background = Color(0x99202026), focusedBackground = Color.White, onClick = { news = true },
            ) { f ->
                Icon(Icons.Filled.Notifications, "New episodes", Modifier.align(Alignment.Center).size(22.dp), tint = if (f) Color.Black else Color.White)
            }
            val unread = fresh.count { !Store.newsPressed(it.media.id, it.episode) }
            if (unread > 0) Box(
                Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-3).dp).size(18.dp).clip(RoundedCornerShape(9.dp)).background(Orange),
                contentAlignment = Alignment.Center,
            ) { KText(unread.toString(), 10, Color.Black, bold = true) }
        }
        if (account) TopPanel(firstAccount, 300.dp) {
            val email = Store.accountEmail
            KText("Account", 14, Muted, bold = true, modifier = Modifier.padding(start = 8.dp, top = 4.dp))
            Column(Modifier.padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (email != null) {
                    KText(email, 15, bold = true, lines = 1)
                    KText("Watching and progress sync with your phone. ${Store.syncState}", 12, Muted)
                } else PhoneQr(PairMode.LOGIN, 190.dp, "Scan to log in from your phone. It needs to be on the same WiFi as this TV.")
            }
            // The first button stays in place so logging in doesn't lose focus.
            Row(Modifier.padding(6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KButton(if (email != null) "Sync now" else "Log in with the remote", focusKey = "acct:first", requester = firstAccount) {
                    if (email != null) scope.launch { Store.sync() }
                    else askText(context, "Email") { e ->
                        if (e.isEmpty()) return@askText
                        askText(context, "Password", password = true) { p ->
                            scope.launch { runCatching { Store.login(e, p) }.onFailure { Toast.makeText(context, it.message ?: "Couldn't log in", Toast.LENGTH_LONG).show() } }
                        }
                    }
                }
                if (email != null) KButton("Log out") { closeAccount(); Store.logout() }
            }
        }
        if (news) TopPanel(firstNews, 330.dp) {
                Row(Modifier.fillMaxWidth().padding(start = 8.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    KText("New episodes", 14, Muted, bold = true, modifier = Modifier.weight(1f))
                    if (fresh.isNotEmpty()) KButton("Clear", focusKey = "news:clear") {
                        val all = fresh.map { it.media.id to it.episode }
                        closeNews()
                        Store.clearNews(all)
                    }
                }
                if (fresh.isEmpty()) Tile(Modifier.fillMaxWidth(), focusKey = "news:none", requester = firstNews, radius = 12.dp, grow = 1f, background = Surface, onClick = { closeNews() }) {
                    KText("You're all caught up", 13, modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp))
                }
                LazyColumn(Modifier.heightIn(max = 400.dp), verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(2.dp)) {
                    itemsIndexed(fresh, key = { _, a -> a.media.id }) { i, a ->
                        Tile(
                            Modifier.fillMaxWidth(), focusKey = "news:${a.media.id}", requester = if (i == 0) firstNews else null, radius = 12.dp, grow = 1f, background = Surface,
                            onClick = {
                                Store.pressNews(a.media.id, a.episode)
                                closeNews()
                                Nav.lastFocus = "bell"
                                Nav.push(Route.Show(a.media.id, a.episode))
                            },
                        ) {
                            // Dimmed once pressed, so it reads as already opened.
                            Row(Modifier.alpha(if (Store.newsPressed(a.media.id, a.episode)) 0.4f else 1f).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                AsyncImage(a.media.cover, null, Modifier.size(40.dp, 56.dp).clip(RoundedCornerShape(6.dp)), contentScale = ContentScale.Crop)
                                Column {
                                    KText(a.media.title, 13, bold = true, lines = 1)
                                    KText("Episode ${a.episode}", 12, Orange, lines = 1)
                                }
                            }
                        }
                    }
                }
        }
    }
    // The dock is hidden, so Back brings it up. Back again goes Home, then exits.
    BackHandler(!open || HomeData.tab != 0) {
        if (!open) runCatching { dock[HomeData.tab].requestFocus() }
        else { HomeData.tab = 0; runCatching { dock[0].requestFocus() } }
    }
    BackHandler(news) { closeNews() }
    BackHandler(account) { closeAccount() }
}

/** The small panel under the bell and account buttons. Arrow keys stay inside it. */
/** Arrow keys can't leave this group, but the app can still move focus out of it. */
@OptIn(ExperimentalComposeUiApi::class)
private fun arrowsStayInside() = Modifier.focusProperties {
    exit = { d ->
        if (d == FocusDirection.Left || d == FocusDirection.Right || d == FocusDirection.Up || d == FocusDirection.Down) FocusRequester.Cancel
        else FocusRequester.Default
    }
}.focusGroup()

@Composable
private fun BoxScope.TopPanel(first: FocusRequester, width: Dp, content: @Composable ColumnScope.() -> Unit) {
    LaunchedEffect(Unit) { withFrameNanos { }; runCatching { first.requestFocus() } }
    Column(
        Modifier.align(Alignment.TopEnd).padding(top = 68.dp, end = 24.dp).width(width)
            .then(arrowsStayInside())
            .background(Color(0xF716161C), RoundedCornerShape(18.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

/** Lazy grids swallow Left on their first column, so it points at the dock here. */
private fun leftEdge(state: LazyGridState, index: Int) = Modifier.focusProperties {
    if (state.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.column == 0) left = HomeData.dockFocus[HomeData.tab]
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
    if (HomeData.rows.isEmpty()) { Centered(if (HomeData.error) "Couldn't reach AniList. Check the connection." else "Loading…"); return }
    val firstListRow = if (cont.isNotEmpty()) 1 else 0
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
        itemsIndexed(HomeData.rows, key = { _, r -> r.key }) { i, r ->
            Rail(i + firstListRow, r.key, r.title, r.items.mapIndexed { n, m -> m.poster(if (firstListRow == 0 && i == 0 && n == 0) "home:first" else "${r.key}:${m.id}") })
        }
    }
    }
    }
}

private class Filter(val key: String, val name: String, val options: List<Pair<String, String>>)

private val Filters = run {
    val now = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)
    listOf(
        Filter("genre", "Genre", listOf("Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller").map { it to it }),
        Filter("season", "Season", listOf("WINTER" to "Winter", "SPRING" to "Spring", "SUMMER" to "Summer", "FALL" to "Fall")),
        Filter("year", "Year", (now + 1 downTo 1970).map { "$it" to "$it" }),
        Filter("format", "Type", listOf("TV" to "TV", "MOVIE" to "Movie", "OVA" to "OVA", "ONA" to "ONA", "SPECIAL" to "Special", "TV_SHORT" to "TV short")),
        Filter("status", "Status", listOf("RELEASING" to "Airing", "FINISHED" to "Finished", "NOT_YET_RELEASED" to "Not yet aired", "HIATUS" to "On hiatus")),
        Filter("country", "Country", listOf("JP" to "Japan", "CN" to "China", "KR" to "South Korea", "TW" to "Taiwan")),
        Filter("rating", "Rating", listOf("90" to "★ 9+", "80" to "★ 8+", "70" to "★ 7+", "60" to "★ 6+", "50" to "★ 5+")),
        Filter("source", "Source", listOf("MANGA" to "Manga", "LIGHT_NOVEL" to "Light novel", "WEB_NOVEL" to "Web novel", "NOVEL" to "Novel", "ORIGINAL" to "Original", "VIDEO_GAME" to "Video game", "VISUAL_NOVEL" to "Visual novel")),
        Filter("episodes", "Episodes", listOf("1-12" to "1–12", "13-26" to "13–26", "27-60" to "27–60", "61-" to "61+")),
        Filter("sort", "Sort: popular", listOf("TRENDING_DESC" to "Sort: trending", "SCORE_DESC" to "Sort: top rated", "START_DATE_DESC" to "Sort: newest", "TITLE_ROMAJI" to "Sort: A–Z")),
        Filter("exclude", "Show everything", listOf("watching" to "Hide my Watching")),
    )
}

object SearchData {
    var query by mutableStateOf("")
    var results by mutableStateOf<List<Media>>(emptyList())
    var busy by mutableStateOf(false)
    var failed by mutableStateOf(false)
    var more = false
    var searches by androidx.compose.runtime.mutableIntStateOf(0)
    val filters = androidx.compose.runtime.mutableStateMapOf<String, String>()
    private var page = 1
    private var run = 0
    private var fetching = false

    private fun vars(): JSONObject {
        val v = JSONObject().put("page", page)
        val f = filters
        if (query.isNotEmpty()) v.put("search", query)
        f["genre"]?.let { v.put("genre", JSONArray().put(it)) }
        f["season"]?.let { v.put("season", it) }
        f["year"]?.let { v.put("year", it.toInt()) }
        f["format"]?.let { v.put("format", JSONArray().put(it)) }
        f["status"]?.let { v.put("status", it) }
        f["country"]?.let { v.put("country", it) }
        f["rating"]?.let { v.put("score", it.toInt() - 1) }
        f["source"]?.let { v.put("source", it) }
        f["episodes"]?.let {
            v.put("epsMin", it.substringBefore("-").toInt() - 1)
            it.substringAfter("-").toIntOrNull()?.let { top -> v.put("epsMax", top + 1) }
        }
        if (f["exclude"] == "watching") {
            val ids = Store.watchingItems().mapNotNull { routeId(it.optString("route")) }
            if (ids.isNotEmpty()) v.put("notIn", JSONArray(ids))
        }
        v.put("sort", JSONArray().put(f["sort"] ?: if (query.isNotEmpty()) "SEARCH_MATCH" else "POPULARITY_DESC"))
        return v
    }

    suspend fun fresh() {
        page = 1
        val mine = ++run
        busy = true
        failed = false
        val found = runCatching { AniList.search(vars()) }.getOrNull()
        if (mine != run) return
        busy = false
        failed = found == null
        results = found?.first.orEmpty()
        more = found?.second ?: false
        searches++
    }

    suspend fun next() {
        if (!more || busy || fetching) return
        fetching = true
        val mine = run
        page++
        val found = runCatching { AniList.search(vars()) }.getOrNull()
        fetching = false
        if (mine != run) return
        if (found == null) { page--; return }
        results = (results + found.first).distinctBy { it.id }
        more = found.second
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SearchScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val gridState = rememberLazyGridState()
    LaunchedEffect(Unit) { if (SearchData.results.isEmpty()) SearchData.fresh() }
    // New results keep the old scroll position when a show is in both, so start at the top.
    LaunchedEffect(SearchData.searches) { gridState.scrollToItem(0) }
    LaunchedEffect(gridState) {
        snapshotFlow { gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
            if (last >= SearchData.results.size - 6) SearchData.next()
        }
    }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, end = 40.dp, top = 22.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KButton(if (SearchData.query.isEmpty()) "Type a title to search" else "Searching: ${SearchData.query}", focusKey = "search:box") {
                askText(context, "Search anime", SearchData.query) { q ->
                    SearchData.query = q
                    scope.launch { SearchData.fresh() }
                }
            }
            val active = SearchData.filters.size
            if (active > 0) KButton(if (active == 1) "Clear 1 filter" else "Clear $active filters") {
                Nav.restore = "search:box"
                SearchData.filters.clear()
                scope.launch { SearchData.fresh() }
            }
        }
        FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Filters.forEach { f ->
                val set = SearchData.filters[f.key]
                KButton(f.options.firstOrNull { it.first == set }?.second ?: f.name, focusKey = "filter:${f.key}", solid = set != null) {
                    pick(context, f.name, listOf(f.name) + f.options.map { it.second }) { i ->
                        if (i == 0) SearchData.filters.remove(f.key) else SearchData.filters[f.key] = f.options[i - 1].first
                        scope.launch { SearchData.fresh() }
                    }
                }
            }
        }
        if (SearchData.busy) KText("Searching…", 14, Muted, modifier = Modifier.padding(top = 14.dp))
        else if (SearchData.failed) KText("Couldn't reach AniList. Check the connection.", 14, Muted, modifier = Modifier.padding(top = 14.dp))
        else if (SearchData.results.isEmpty()) KText("Nothing matches. Try fewer filters.", 14, Muted, modifier = Modifier.padding(top = 14.dp))
        LazyVerticalGrid(GridCells.Adaptive(PosterW + 14.dp), Modifier.padding(top = 10.dp), state = gridState, contentPadding = PaddingValues(6.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            itemsIndexed(SearchData.results, key = { _, m -> m.id }) { i, m -> Poster(m.poster("search:${m.id}"), leftEdge(gridState, i)) }
        }
    }
}

@Composable
fun WatchingScreen() {
    val v = Store.version
    val list = remember(v) { Store.watchingItems() }
    val state = rememberLazyGridState()
    LaunchedEffect(list.size) { AniList.loadRatings(list.mapNotNull { routeId(it.optString("route")) }) }
    if (list.isEmpty()) { Centered("Shows you add to Watching appear here."); return }
    LazyVerticalGrid(GridCells.Adaptive(PosterW + 14.dp), state = state, contentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = 72.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        itemsIndexed(list, key = { _, o -> o.optString("route") }) { i, o ->
            val id = routeId(o.optString("route")) ?: return@itemsIndexed
            Poster(PosterItem("watching:$id", id, o.str("title") ?: "", o.str("poster"), ""), leftEdge(state, i))
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
    Row(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
    Column(Modifier.width(290.dp).padding(top = 40.dp, end = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        KText("Add from your phone", 16, bold = true)
        PhoneQr(PairMode.ADDONS, 220.dp, "Scan, then paste your add-on links. Your phone needs to be on the same WiFi as this TV.")
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
            Toggle("Menu sound", Store.menuSound, "set:sound") { Store.menuSound = !Store.menuSound }
        }
        KText("Add-ons and devices", 15, Muted, bold = true, modifier = Modifier.padding(top = 18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            KButton(if (addonCount == 1) "Add-ons  ·  1 installed" else "Add-ons  ·  $addonCount installed", focusKey = "set:addons") { Nav.push(Route.Addons) }
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
fun ShowScreen(id: Int, ep: Int? = null, choose: Boolean = false) {
    val context = LocalContext.current
    var media by remember { mutableStateOf<Media?>(null) }
    var failed by remember { mutableStateOf(false) }
    var marking by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(id) { runCatching { media = AniList.media(id) }.onFailure { failed = true } }
    val m = media ?: run { Centered(if (failed) "Couldn't load this show." else "Loading…"); return }
    val v = Store.version
    val count = m.episodeCount
    val next = remember(v) { Store.nextEpisode(m.route).coerceIn(1, maxOf(1, count)) }
    val episodes = rememberLazyGridState()
    LaunchedEffect(m.id) {
        if (ep != null && ep <= count) {
            // Opened from the bell: start on the new episode, however far down it is.
            episodes.scrollToItem(ep - 1)
            withFrameNanos { }
            Nav.restore = if (m.isMovie) "show:play" else "ep:$ep"
            if (choose) { withFrameNanos { }; withFrameNanos { }; choosing = ep }
        } else if (Nav.restore == null) Nav.restore = "show:play"
    }
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
                    if (count > 0) KButton(if (m.isMovie) "Play" else "Play episode $next", focusKey = "show:play", solid = true) { LastFailure.message = null; choosing = next }
                    KButton(if (Store.inWatchlist(m.route)) "✓ Watching" else "+ Watching", focusKey = "show:list") { Store.toggleWatch(m.route, m.title, m.cover) }
                    if (!m.isMovie && count > 0) KButton(if (marking) "Done marking" else "Mark watched") { marking = !marking }
                }
                LastFailure.message?.let { KText(it, 13, Orange, modifier = Modifier.padding(top = 10.dp)) }
                if (marking) KText("Press OK on an episode to mark it watched or unwatched.", 13, Orange, modifier = Modifier.padding(top = 10.dp))
                if (!m.isMovie) {
                    if (count == 0) KText("No episodes have aired yet.", 14, Muted, modifier = Modifier.padding(top = 16.dp))
                    LazyVerticalGrid(GridCells.Adaptive(62.dp), Modifier.padding(top = 14.dp), state = episodes, contentPadding = PaddingValues(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items((1..count).toList(), key = { it }) { n ->
                            val pct = Store.percent(m.route, n)
                            val seen = pct > 0.92f
                            Tile(Modifier.height(44.dp), focusKey = "ep:$n", radius = 12.dp, outline = false, background = if (seen) Color(0x33FF8A1F) else Surface, focusedBackground = Color.White, onClick = {
                                if (marking) Store.markWatched(m.route, n, !seen, m.title, m.cover)
                                else { LastFailure.message = null; choosing = n }
                            }) { f ->
                                KText((if (seen) "✓ " else "") + n, 14, if (f) Color.Black else if (seen) Orange else Color.White, bold = true, modifier = Modifier.align(Alignment.Center))
                                if (pct > 0f && !seen) Bar(pct, Modifier.align(Alignment.BottomStart))
                            }
                        }
                    }
                }
            }
        }
        choosing?.let { n ->
            EpisodeDock(m, n) {
                Nav.restore = if (m.isMovie) "show:play" else "ep:$n"
                choosing = null
            }
        }
    }
}

object LastFailure { var message by mutableStateOf<String?>(null) }

/** Sources for one episode, kept out of sight. */
private class EpisodeSources {
    var media by mutableStateOf<Media?>(null)
    val rows = mutableStateListOf<StreamRow>()
    var subtitles = emptyList<Subtitle>()
    var ids: ShowIds? = null
    var done by mutableStateOf(false)
    var failed by mutableStateOf(false)

    /** Sources of this type, the best first and those naming this episode ahead of the rest. */
    fun best(kind: Audio, ep: Int): List<StreamRow> {
        val mine = rows.filter { it.audio == kind }
        val named = Regex("(?:E|[ ._-])0*$ep(?:[ ._)\\[(-]|v\\d|$)", RegexOption.IGNORE_CASE)
        return StreamLogic.autoCandidates(mine, kind).sortedByDescending { named.containsMatchIn("${it.stream.title ?: ""} ${it.stream.filename ?: ""} ${it.stream.description ?: ""}") }
    }

    fun play(ep: Int, list: List<StreamRow>) {
        val m = media ?: return
        val i = ids ?: return
        Nav.push(Route.Player(PlaySession(m, ep, list, subtitles, i)))
    }

    /** Waits for every add-on, or 4 seconds if a cached source of this type is already here. */
    suspend fun ready(kind: Audio) {
        val began = System.currentTimeMillis()
        while (!done && !(rows.any { it.audio == kind && StreamLogic.isCached(it.stream) } && System.currentTimeMillis() - began > 4000)) delay(200)
    }
}

@Composable
private fun rememberSources(id: Int, ep: Int): EpisodeSources {
    val sources = remember(id, ep) { EpisodeSources() }
    LaunchedEffect(sources) {
        val m = runCatching { AniList.media(id) }.getOrNull()
        if (m == null) { sources.failed = true; sources.done = true; return@LaunchedEffect }
        sources.media = m
        val ids = AniList.showIds(m)
        sources.ids = ids
        launch { sources.subtitles = Addons.subtitles(Store.addons, ids, ep, m.isMovie) }
        Addons.streams(Store.addons, ids, ep, m.isMovie).collect { (addon, list) ->
            list.forEach { s -> sources.rows.add(StreamRow(addon, s, StreamLogic.audio(s), sources.rows.size)) }
        }
        sources.done = true
    }
    return sources
}

/** The Sub, Dub or Other last chosen, which the next episode uses too. */
private var lastKind: Audio? = null

/** Pick a type and the best source of it plays. */
@Composable
private fun BoxScope.EpisodeDock(m: Media, ep: Int, onClose: () -> Unit) {
    val sources = rememberSources(m.id, ep)
    var chosen by remember { mutableStateOf<Audio?>(null) }
    val kinds = listOf(Audio.SUB to "Sub", Audio.DUB to "Dub", Audio.OTHER to "Other")
    val preferred = lastKind ?: Store.prefer
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { withFrameNanos { }; runCatching { first.requestFocus() } }
    LaunchedEffect(chosen) {
        val kind = chosen ?: return@LaunchedEffect
        sources.ready(kind)
        val list = sources.best(kind, ep)
        chosen = null
        if (list.isEmpty()) return@LaunchedEffect
        lastKind = kind
        Nav.lastFocus = if (m.isMovie) "show:play" else "ep:$ep"
        sources.play(ep, list)
    }
    BackHandler { if (chosen != null) chosen = null else onClose() }
    Column(
        Modifier.align(Alignment.Center).width(320.dp).then(arrowsStayInside())
            .background(Color(0xF716161C), RoundedCornerShape(18.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        KText(if (m.isMovie) m.title else "Episode $ep", 16, bold = true, lines = 1, modifier = Modifier.padding(start = 8.dp, top = 2.dp))
        KText(
            when {
                Store.addons.none { it.enabled } -> "Add an add-on first, in Settings."
                sources.failed -> "Couldn't load this episode."
                sources.done && sources.rows.isEmpty() -> "No sources found."
                else -> chosen?.let { c -> "Starting ${kinds.first { it.first == c }.second}…" } ?: "Choose how to watch"
            },
            12, Muted, modifier = Modifier.padding(start = 8.dp, bottom = 4.dp),
        )
        kinds.forEach { (kind, name) ->
            val count = sources.rows.count { it.audio == kind }
            Tile(
                Modifier.fillMaxWidth(), focusKey = "dock:$name", requester = if (kind == preferred) first else null, radius = 12.dp, grow = 1f,
                outline = false, background = Surface, focusedBackground = Color.White,
                onClick = { if (count > 0 || !sources.done) chosen = kind },
            ) { f ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                    KText(name, 15, if (f) Color.Black else Color.White, bold = true, modifier = Modifier.weight(1f))
                    KText(if (count > 0) "Ready" else if (sources.done) "None found" else "Looking…", 12, if (f) Color.DarkGray else Muted)
                }
            }
        }
    }
}

/** Loads the next episode for Auto Next, using the type chosen last. */
@Composable
fun WatchScreen(r: Route.Watch) {
    val sources = rememberSources(r.id, r.ep)
    val kind = lastKind ?: Store.prefer
    LaunchedEffect(sources) {
        LastFailure.message = null
        sources.ready(kind)
        val list = sources.best(kind, r.ep).ifEmpty { Audio.entries.flatMap { sources.best(it, r.ep) } }
        if (list.isNotEmpty()) sources.play(r.ep, list)
    }
    val m = sources.media
    Box(Modifier.fillMaxSize()) {
        m?.let { Backdrop(it) }
        Centered(if (sources.done && sources.rows.isEmpty()) "No sources found for episode ${r.ep}." else "Loading episode ${r.ep}…")
    }
}
