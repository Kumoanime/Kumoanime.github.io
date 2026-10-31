package app.kumo.tv

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

object Splash { var done by mutableStateOf(false) }

private const val SPLASH_MS = 5000
private const val FADE_MS = 300

/** The opening screen: the logo slams in over manga speed lines while a power bar charges. */
@Composable
fun SplashScreen() {
    val charge = remember { Animatable(0f) }
    val scale = remember { Animatable(1.8f) }
    val fade = remember { Animatable(1f) }
    LaunchedEffect(Unit) {
        launch { scale.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = Spring.StiffnessMediumLow)) }
        charge.animateTo(1f, tween(SPLASH_MS - FADE_MS, easing = LinearEasing))
        fade.animateTo(0f, tween(FADE_MS))
        Splash.done = true
    }
    // Stepped on purpose: speed lines redraw a few times a second, like hand drawn frames.
    val frame by rememberInfiniteTransition(label = "lines").animateFloat(0f, 1000f, infiniteRepeatable(tween(90_000, easing = LinearEasing), RepeatMode.Restart), label = "frame")
    Box(Modifier.fillMaxSize().graphicsLayer { alpha = fade.value }.background(Color.Black), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val random = java.util.Random(frame.toLong())
            val center = Offset(size.width / 2, size.height / 2 - 30)
            val far = hypot(size.width, size.height)
            for (i in 0 until 90) {
                val angle = (i * 4f + random.nextFloat() * 3f) * (Math.PI.toFloat() / 180f)
                val inner = size.height * (0.34f + random.nextFloat() * 0.22f)
                val spread = 0.004f + random.nextFloat() * 0.012f
                val tip = Offset(center.x + cos(angle) * inner, center.y + sin(angle) * inner)
                val a = Offset(center.x + cos(angle - spread) * far, center.y + sin(angle - spread) * far)
                val b = Offset(center.x + cos(angle + spread) * far, center.y + sin(angle + spread) * far)
                val line = Path().apply { moveTo(tip.x, tip.y); lineTo(a.x, a.y); lineTo(b.x, b.y); close() }
                drawPath(line, Orange.copy(alpha = 0.12f + random.nextFloat() * 0.3f))
            }
        }
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
            KText("読み込み中…  ${(charge.value * 100).toInt()}%", 15, Color.White, bold = true, modifier = Modifier.padding(top = 0.dp))
        }
    }
}
