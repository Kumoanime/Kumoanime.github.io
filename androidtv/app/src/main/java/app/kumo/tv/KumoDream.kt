package app.kumo.tv

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.service.dreams.DreamService
import android.util.TypedValue
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextClock
import java.io.File
import kotlin.concurrent.thread

/**
 * The TV's screensaver: the wallpapers in Kumo's screensaver folder, shuffled.
 * They're copied there over ADB rather than built in, so the repo holds no pictures.
 */
class KumoDream : DreamService() {
    private val main = Handler(Looper.getMainLooper())
    private val next = Runnable { showNext() }
    private lateinit var front: ImageView
    private lateinit var back: ImageView
    private lateinit var clock: TextClock
    private var queue = emptyList<File>()
    private var running = false

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = false
        isFullscreen = true
        front = picture()
        back = picture()
        clock = TextClock(this).apply {
            format12Hour = "HH:mm"
            format24Hour = "HH:mm"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f)
            setShadowLayer(10f, 0f, 2f, Color.BLACK)
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(back)
            addView(front)
            val margin = (32 * resources.displayMetrics.density).toInt()
            addView(clock, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { setMargins(margin, margin, margin, margin) })
        }
        setContentView(root)
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        running = true
        showNext()
    }

    override fun onDreamingStopped() {
        running = false
        main.removeCallbacks(next)
        super.onDreamingStopped()
    }

    private fun picture() = ImageView(this).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        alpha = 0f
    }

    private fun showNext() {
        if (queue.isEmpty()) queue = pictures().shuffled()
        val file = queue.firstOrNull() ?: return
        queue = queue.drop(1)
        thread(name = "KumoDream") {
            val bitmap = runCatching { decode(file) }.getOrNull()
            main.post {
                if (!running) return@post
                if (bitmap != null) crossfade(bitmap)
                main.postDelayed(next, CHANGE_MS)
            }
        }
    }

    private fun crossfade(bitmap: Bitmap) {
        back.setImageBitmap(bitmap)
        back.bringToFront()
        clock.bringToFront()
        back.alpha = 0f
        back.animate().alpha(1f).setDuration(FADE_MS).start()
        val shown = front
        front = back
        back = shown
    }

    private fun pictures(): List<File> =
        getExternalFilesDir("screensaver")?.listFiles { f -> f.extension.lowercase() in setOf("jpg", "jpeg", "png") }?.toList().orEmpty()

    private fun decode(file: File): Bitmap? {
        val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, size)
        var sample = 1
        while (size.outWidth / (sample * 2) >= 1920 && size.outHeight / (sample * 2) >= 1080) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private companion object {
        const val CHANGE_MS = 60_000L
        const val FADE_MS = 2_000L
    }
}
