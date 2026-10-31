package app.kumo.tv

import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import android.widget.Toast
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import android.app.AlertDialog
import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage

val Orange = Color(0xFFFF8A1F)
val Pink = Color(0xFFFF4F8B)
val Surface = Color(0x1FFFFFFF)
val Raise = Color(0x2EFFFFFF)
val Muted = Color(0xFFB4B4BE)

/** Any item the remote can land on: it grows and gets an orange edge when focused. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Tile(
    modifier: Modifier = Modifier,
    focusKey: String? = null,
    requester: FocusRequester? = null,
    radius: Dp = 12.dp,
    grow: Float = 1.07f,
    outline: Boolean = true,
    background: Color = Color.Transparent,
    focusedBackground: Color = background,
    onFocused: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
    content: @Composable BoxScope.(Boolean) -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val focusRequester = requester ?: remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val hold = remember { HoldOk() }
    val wanted = Nav.restore
    LaunchedEffect(focusKey, wanted) {
        if (focusKey != null && wanted == focusKey) {
            Nav.restore = null
            runCatching { focusRequester.requestFocus() }
        }
    }
    val shape = RoundedCornerShape(radius)
    val scale by animateFloatAsState(if (focused) grow else 1f, tween(140), label = "focus")
    Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .focusRequester(focusRequester)
            .onFocusChanged {
                if (it.isFocused) {
                    Sounds.moved()
                    if (focusKey != null) {
                        Nav.lastFocus = focusKey
                        android.util.Log.d("KumoKeys", "focus $focusKey")
                    }
                    onFocused?.invoke()
                }
            }
            .clip(shape)
            .background(if (focused) focusedBackground else background)
            .border(if (focused && outline) 2.dp else 0.dp, if (focused && outline) Color.White else Color.Transparent, shape)
            .then(
                if (onLongClick == null) Modifier
                else Modifier.onPreviewKeyEvent { e ->
                    val native = e.nativeKeyEvent
                    if (native.keyCode != android.view.KeyEvent.KEYCODE_DPAD_CENTER && native.keyCode != android.view.KeyEvent.KEYCODE_ENTER) return@onPreviewKeyEvent false
                    if (e.type == KeyEventType.KeyDown && native.repeatCount == 0) {
                        hold.armed = true
                        hold.timer = scope.launch {
                            delay(600)
                            hold.armed = false
                            onLongClick()
                        }
                    } else if (e.type == KeyEventType.KeyUp) {
                        hold.timer?.cancel()
                        if (hold.armed) onClick()
                        hold.armed = false
                    }
                    true
                },
            )
            .combinedClickable(interactionSource = source, indication = null, onLongClick = onLongClick, onClick = onClick),
    ) { content(focused) }
}

/** A soft tick when an arrow press moves focus. Silent in the player and for focus the app moves itself. */
object Sounds {
    private var pool: android.media.SoundPool? = null
    private var tick = 0

    fun load(context: Context) {
        val attributes = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        pool = android.media.SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attributes).build().also { tick = it.load(context, R.raw.tick, 1) }
    }

    fun moved() {
        val now = System.currentTimeMillis()
        if (now - Nav.moveAt > 400) return
        Nav.moveAt = 0
        if (Store.menuSound && Nav.stack.last() !is Route.Player) pool?.play(tick, 0.35f, 0.35f, 1, 0, 1f)
    }
}

/** Remotes differ in what they send while OK is held, so a timer decides what a hold is. */
private class HoldOk {
    var armed = false
    var timer: Job? = null
}

@Composable
fun KText(text: String, size: Int = 15, color: Color = Color.White, bold: Boolean = false, lines: Int = Int.MAX_VALUE, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier, color = color, fontSize = size.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal, maxLines = lines, overflow = TextOverflow.Ellipsis)
}

@Composable
fun KButton(label: String, modifier: Modifier = Modifier, focusKey: String? = null, solid: Boolean = false, requester: FocusRequester? = null, onClick: () -> Unit) {
    Tile(modifier, focusKey = focusKey, requester = requester, radius = 22.dp, grow = 1.05f, outline = false, background = if (solid) Orange else Raise, focusedBackground = Color.White, onClick = onClick) { f ->
        KText(label, 14, if (f || solid) Color.Black else Color.White, bold = true, modifier = Modifier.padding(horizontal = 20.dp, vertical = 9.dp))
    }
}

class Hero(val title: String, val image: String?, val meta: String, val text: String?)

class PosterItem(val key: String, val id: Int, val title: String, val image: String?, val sub: String, val pct: Float? = null, val rating: String? = null, val ep: Int? = null, val hero: Hero? = null, val caption: Boolean = true, val onRemove: (() -> Unit)? = null)

val PosterW = 118.dp
val PosterH = 170.dp

/** Sits above the poster, or below it when there's no room. */
private object AbovePoster : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val x = anchorBounds.left.coerceIn(16, maxOf(16, windowSize.width - popupContentSize.width - 16))
        val above = anchorBounds.top - popupContentSize.height - 12
        return IntOffset(x, if (above >= 12) above else anchorBounds.bottom + 12)
    }
}

/** Title, rating and description, after a few seconds on a poster. */
@Composable
private fun PosterDock(id: Int) {
    var media by remember { mutableStateOf<Media?>(null) }
    LaunchedEffect(id) {
        delay(2500)
        media = runCatching { AniList.media(id) }.getOrNull()
    }
    val m = media ?: return
    Popup(popupPositionProvider = AbovePoster, properties = PopupProperties(focusable = false)) {
        var shown by remember { mutableStateOf(false) }
        LaunchedEffect(Unit) { shown = true }
        val fade by animateFloatAsState(if (shown) 1f else 0f, tween(180), label = "dock")
        Column(
            Modifier.width(340.dp).graphicsLayer { alpha = fade }.background(Color(0xF716161C), RoundedCornerShape(16.dp)).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            KText(m.title, 16, bold = true, lines = 2)
            KText(m.metaLine(), 12, Orange, lines = 1)
            KText(m.synopsis ?: "No description yet.", 12, Color(0xFFD5D5DB), lines = 5)
        }
    }
}

@Composable
fun Poster(item: PosterItem, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val rating = item.rating ?: AniList.ratings[item.id]
    var focused by remember { mutableStateOf(false) }
    Store.version  // Adds or removes the tick when Watching changes.
    val watching = Store.inWatchlist("#/a/${item.id}")
    if (focused) PosterDock(item.id)
    Column(modifier.width(PosterW).onFocusChanged { focused = it.hasFocus }) {
        Tile(
            Modifier.width(PosterW).height(PosterH),
            focusKey = item.key,
            background = Surface,
            onFocused = { item.hero?.let { HomeData.heroTarget = it; HomeData.heroId = item.id } },
            onLongClick = { posterMenu(context, item) },
            onClick = { Nav.push(Route.Show(item.id, item.ep, choose = item.ep != null)) },
        ) {
            if (item.image != null) AsyncImage(item.image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else KText(item.title, 13, bold = true, modifier = Modifier.padding(8.dp))
            item.pct?.let { Bar(it, Modifier.align(Alignment.BottomStart)) }
            if (watching) Box(
                Modifier.align(Alignment.TopStart).padding(5.dp).size(19.dp).clip(RoundedCornerShape(10.dp)).background(Orange),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Check, "In Watching", Modifier.size(13.dp), tint = Color.Black) }
            if (rating != null) Row(
                Modifier.align(Alignment.TopEnd).padding(5.dp).clip(RoundedCornerShape(7.dp)).background(Color(0xCC000000)).padding(horizontal = 5.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Star, null, Modifier.size(10.dp), tint = Orange)
                KText(rating, 10, bold = true)
            }
        }
        if (item.caption) {
            KText(item.title, 12, bold = true, lines = 1, modifier = Modifier.padding(top = 7.dp))
            KText(item.sub, 11, Muted, lines = 1)
        }
    }
}

@Composable
fun Bar(pct: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0x55FFFFFF))) {
        Box(Modifier.fillMaxWidth(pct.coerceIn(0f, 1f)).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Orange))
    }
}

@Composable
fun Centered(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { KText(text, 16, Muted) }
}

fun Media.metaLine() = listOfNotNull(rating?.let { "★ $it" }, seasonYear?.toString(), format?.replace("_", " "), genres.take(3).joinToString(", ").ifEmpty { null }).joinToString("   ·   ")
fun Media.hero() = Hero(title, banner ?: cover, metaLine(), synopsis)
fun Media.poster(key: String) = PosterItem(key, id, title, cover, "", rating = rating, hero = hero(), caption = false)

/** A native dialog: Android handles the remote and the on-screen keyboard for it. */
fun askText(context: Context, title: String, initial: String = "", password: Boolean = false, onDone: (String) -> Unit) {
    val field = EditText(context).apply {
        setText(initial)
        setSingleLine(true)
        inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setTextColor(android.graphics.Color.WHITE)
    }
    val box = FrameLayout(context).apply { setPadding(48, 16, 48, 0); addView(field) }
    AlertDialog.Builder(context, android.R.style.Theme_Material_Dialog_Alert)
        .setTitle(title).setView(box)
        .setPositiveButton("OK") { _, _ -> onDone(field.text.toString().trim()) }
        .setNegativeButton("Cancel", null)
        .show()
    field.requestFocus()
}

fun confirm(context: Context, title: String, action: String, onYes: () -> Unit) {
    AlertDialog.Builder(context, android.R.style.Theme_Material_Dialog_Alert)
        .setTitle(title)
        .setPositiveButton(action) { _, _ -> onYes() }
        .setNegativeButton("Cancel", null)
        .show()
}

/** What holding OK on a poster offers. */
private fun posterMenu(context: Context, item: PosterItem) {
    val route = "#/a/${item.id}"
    val watching = Store.inWatchlist(route)
    val options = listOf(if (watching) "Remove from Watching" else "Add to Watching") + listOfNotNull(if (item.onRemove != null) "Remove from Continue watching" else null)
    pick(context, item.title, options) { i ->
        if (i == 0) {
            Store.toggleWatch(route, item.title, item.image)
            Toast.makeText(context, if (watching) "Removed from Watching" else "Added to Watching", Toast.LENGTH_SHORT).show()
        } else item.onRemove?.invoke()
    }
}

fun pick(context: Context, title: String, items: List<String>, onPick: (Int) -> Unit) {
    AlertDialog.Builder(context, android.R.style.Theme_Material_Dialog_Alert)
        .setTitle(title)
        .setItems(items.toTypedArray()) { _, i -> onPick(i) }
        .show()
}

@Composable
fun Toggle(label: String, on: Boolean, focusKey: String? = null, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Tile(modifier, focusKey = focusKey, radius = 22.dp, grow = 1.04f, outline = false, background = Raise, focusedBackground = Color.White, onClick = onClick) { f ->
        Row(Modifier.padding(horizontal = 16.dp, vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            KText(label, 14, if (f) Color.Black else Color.White, bold = true)
            Box(Modifier.size(28.dp, 16.dp).clip(RoundedCornerShape(8.dp)).background(if (on) Orange else Color(0x66808088)), contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart) {
                Box(Modifier.padding(2.dp).size(12.dp).clip(RoundedCornerShape(6.dp)).background(Color.White))
            }
        }
    }
}
