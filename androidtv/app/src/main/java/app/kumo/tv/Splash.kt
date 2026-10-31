package app.kumo.tv

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

object Splash {
    var done by mutableStateOf(false)
    /** The app itself waits behind this, so building it can't stutter the animation. */
    var showApp by mutableStateOf(false)
}

private const val SPLASH_MS = 5000L
private const val HOLD_MS = 300L
private const val FADE_MS = 300L

/** Hand drawn looking frames of radial speed lines, made once at half size. */
private fun speedLines(seed: Long): ImageBitmap {
    val width = 960
    val height = 540
    val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    canvas.drawColor(android.graphics.Color.BLACK)
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    val random = java.util.Random(seed)
    val cx = width / 2f
    val cy = height / 2f - 15f
    val far = hypot(width.toFloat(), height.toFloat())
    for (i in 0 until 90) {
        val angle = (i * 4f + random.nextFloat() * 3f) * (Math.PI.toFloat() / 180f)
        val inner = height * (0.34f + random.nextFloat() * 0.22f)
        val spread = 0.004f + random.nextFloat() * 0.012f
        val line = android.graphics.Path().apply {
            moveTo(cx + cos(angle) * inner, cy + sin(angle) * inner)
            lineTo(cx + cos(angle - spread) * far, cy + sin(angle - spread) * far)
            lineTo(cx + cos(angle + spread) * far, cy + sin(angle + spread) * far)
            close()
        }
        paint.color = Orange.copy(alpha = 0.12f + random.nextFloat() * 0.3f).toArgb()
        canvas.drawPath(line, paint)
    }
    return bitmap.asImageBitmap()
}

@Composable
private fun SpeedLines(frames: List<ImageBitmap>) {
    var index by remember { mutableIntStateOf(0) }
    LaunchedEffect(frames) {
        while (true) {
            delay(110)
            index = (index + 1 + (0..1).random()) % frames.size
        }
    }
    Image(frames[index], null, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
}

@Composable
private fun Percent(charge: Animatable<Float, *>) {
    val percent by remember { derivedStateOf { (charge.value * 100).toInt() } }
    KText("読み込み中…  $percent%", 15, Color.White, bold = true)
}

/** The opening screen: the logo slams in over manga speed lines while a power bar charges. */
@Composable
fun SplashScreen() {
    val charge = remember { Animatable(0f) }
    val scale = remember { Animatable(1.8f) }
    val fade = remember { Animatable(1f) }
    var frames by remember { mutableStateOf<List<ImageBitmap>>(emptyList()) }
    LaunchedEffect(Unit) {
        launch { runCatching { HomeData.load() } }
        frames = withContext(Dispatchers.Default) { (1L..5L).map { speedLines(it) } }
        launch { scale.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = Spring.StiffnessMediumLow)) }
        charge.animateTo(1f, tween((SPLASH_MS - HOLD_MS - FADE_MS).toInt(), easing = LinearEasing))
        Splash.showApp = true
        delay(HOLD_MS)
        fade.animateTo(0f, tween(FADE_MS.toInt()))
        Splash.done = true
    }
    Box(Modifier.fillMaxSize().graphicsLayer { alpha = fade.value }.background(Color.Black), contentAlignment = Alignment.Center) {
        if (frames.isEmpty()) return@Box
        SpeedLines(frames)
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(30.dp)) {
            Image(painterResource(R.drawable.logo_big), "Kumo", Modifier.height(130.dp).graphicsLayer { scaleX = scale.value; scaleY = scale.value })
            Canvas(Modifier.width(420.dp).height(14.dp)) {
                val lean = size.height * 1.2f
                fun bar(width: Float) = Path().apply {
                    moveTo(lean, 0f); lineTo(width, 0f); lineTo(width - lean, size.height); lineTo(0f, size.height); close()
                }
                drawPath(bar(size.width), Color(0xFF2A2A30))
                val filled = lean + (size.width - lean) * charge.value
                drawPath(bar(filled), Orange)
                drawLine(Color.White, Offset(filled, 0f), Offset(filled - lean, size.height), strokeWidth = 4f)
            }
            Percent(charge)
        }
    }
}
