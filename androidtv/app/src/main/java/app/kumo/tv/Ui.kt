package app.kumo.tv

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
val Surface = Color(0xFF17171B)
val Raise = Color(0xFF26262C)
val Muted = Color(0xFFA5A5AE)

/** Any item the remote can land on: it grows and gets an orange edge when focused. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Tile(
    modifier: Modifier = Modifier,
    focusKey: String? = null,
    radius: Dp = 10.dp,
    grow: Float = 1.06f,
    background: Color = Color.Transparent,
    focusedBackground: Color = background,
    onFocused: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
    content: @Composable BoxScope.(Boolean) -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val requester = remember { FocusRequester() }
    val wanted = Nav.restore
    LaunchedEffect(focusKey, wanted) {
        if (focusKey != null && wanted == focusKey) {
            Nav.restore = null
            runCatching { requester.requestFocus() }
        }
    }
    val shape = RoundedCornerShape(radius)
    Box(
        modifier
            .graphicsLayer { val s = if (focused) grow else 1f; scaleX = s; scaleY = s }
            .focusRequester(requester)
            .onFocusChanged {
                if (it.isFocused) {
                    if (focusKey != null) Nav.lastFocus = focusKey
                    onFocused?.invoke()
                }
            }
            .clip(shape)
            .background(if (focused) focusedBackground else background)
            .border(if (focused) 3.dp else 0.dp, if (focused) Orange else Color.Transparent, shape)
            .combinedClickable(interactionSource = source, indication = null, onLongClick = onLongClick, onClick = onClick),
    ) { content(focused) }
}

@Composable
fun KText(text: String, size: Int = 15, color: Color = Color.White, bold: Boolean = false, lines: Int = Int.MAX_VALUE, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier, color = color, fontSize = size.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal, maxLines = lines, overflow = TextOverflow.Ellipsis)
}

@Composable
fun KButton(label: String, modifier: Modifier = Modifier, focusKey: String? = null, solid: Boolean = false, onClick: () -> Unit) {
    Tile(modifier, focusKey = focusKey, radius = 8.dp, grow = 1.04f, background = if (solid) Pink else Raise, onClick = onClick) {
        KText(label, 15, bold = true, modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp))
    }
}

class PosterItem(val key: String, val id: Int, val title: String, val image: String?, val sub: String, val pct: Float? = null, val rating: String? = null, val ep: Int? = null, val onLong: (() -> Unit)? = null)

val PosterW = 128.dp
val PosterH = 184.dp

@Composable
fun Poster(item: PosterItem, modifier: Modifier = Modifier) {
    Column(modifier.width(PosterW)) {
        Tile(
            Modifier.width(PosterW).height(PosterH),
            focusKey = item.key,
            background = Surface,
            onLongClick = item.onLong,
            onClick = { if (item.ep != null) Nav.push(Route.Watch(item.id, item.ep, false)) else Nav.push(Route.Show(item.id)) },
        ) {
            if (item.image != null) AsyncImage(item.image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else KText(item.title, 13, bold = true, modifier = Modifier.padding(8.dp))
            item.rating?.let {
                KText("★ $it", 11, Color(0xFFFFC04D), modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).background(Color(0xD0000000), RoundedCornerShape(8.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
            }
            item.pct?.let { Bar(it, Modifier.align(Alignment.BottomStart)) }
        }
        KText(item.title, 12, bold = true, lines = 1, modifier = Modifier.padding(top = 6.dp))
        KText(item.sub, 11, Muted, lines = 1)
    }
}

@Composable
fun Bar(pct: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp).background(Color(0x66000000))) {
        Box(Modifier.fillMaxWidth(pct.coerceIn(0f, 1f)).height(4.dp).background(Pink))
    }
}

@Composable
fun Centered(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { KText(text, 16, Muted) }
}

fun Media.poster(key: String) = PosterItem(key, id, title, cover, listOfNotNull(seasonYear?.toString(), format?.replace("_", " ")).joinToString(" · "), rating = rating)

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

fun pick(context: Context, title: String, items: List<String>, onPick: (Int) -> Unit) {
    AlertDialog.Builder(context, android.R.style.Theme_Material_Dialog_Alert)
        .setTitle(title)
        .setItems(items.toTypedArray()) { _, i -> onPick(i) }
        .show()
}

@Composable
fun Toggle(label: String, on: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Tile(modifier, radius = 8.dp, grow = 1.03f, background = Raise, onClick = onClick) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            KText(label, 14)
            Box(Modifier.size(12.dp).clip(RoundedCornerShape(6.dp)).background(if (on) Orange else Color(0xFF55555C)))
        }
    }
}
