package app.kumo.tv

import android.net.Uri
import android.view.KeyEvent as NativeKey
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

class PlaySession(val media: Media, val ep: Int, val candidates: List<StreamRow>)

private fun clock(sec: Double): String {
    val s = sec.toInt().coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

@OptIn(UnstableApi::class)
private fun buildPlayer(context: android.content.Context): ExoPlayer {
    val http = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(25_000)
        .setReadTimeoutMs(25_000)
        .setUserAgent("Kumo/1.0 (Android TV)")
    // Small buffers: this TV has 1.4 GB of memory and a 32-bit system.
    val load = DefaultLoadControl.Builder()
        .setBufferDurationsMs(12_000, 30_000, 1_500, 4_000)
        .setTargetBufferBytes(64 * 1024 * 1024)
        .setPrioritizeTimeOverSizeThresholds(false)
        .build()
    return ExoPlayer.Builder(context, DefaultRenderersFactory(context).setEnableDecoderFallback(true))
        .setMediaSourceFactory(DefaultMediaSourceFactory(context).setDataSourceFactory(http))
        .setLoadControl(load)
        .setSeekForwardIncrementMs(10_000)
        .build()
}

@OptIn(UnstableApi::class)
private fun itemFor(s: Stream, id: String): MediaItem {
    val url = s.url ?: ""
    val b = MediaItem.Builder().setUri(url).setMediaId(id)
    if (url.substringBefore('?').lowercase().endsWith(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8)
    val subs = s.subtitles.take(20).map { sub ->
        val path = sub.url.substringBefore('?').lowercase()
        val mime = when {
            path.endsWith(".vtt") -> MimeTypes.TEXT_VTT
            path.endsWith(".ass") || path.endsWith(".ssa") -> MimeTypes.TEXT_SSA
            else -> MimeTypes.APPLICATION_SUBRIP
        }
        MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.url)).setMimeType(mime).setLanguage(sub.lang.ifEmpty { null }).setLabel(sub.lang.ifEmpty { "Subtitles" }).build()
    }
    if (subs.isNotEmpty()) b.setSubtitleConfigurations(subs)
    return b.build()
}

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(session: PlaySession) {
    val context = LocalContext.current
    val m = session.media
    val key = "${m.route}:${session.ep}"
    val label = if (m.isMovie) "Movie" else "Episode ${session.ep}"
    val hasNext = !m.isMovie && session.ep < m.episodeCount
    val player = remember { buildPlayer(context) }
    val focus = remember { FocusRequester() }

    var index by remember { mutableIntStateOf(0) }
    var ready by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf(false) }
    var time by remember { mutableDoubleStateOf(0.0) }
    var duration by remember { mutableDoubleStateOf(0.0) }
    var paused by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(true) }
    var overlayUntil by remember { mutableStateOf(System.currentTimeMillis() + 3000) }
    var note by remember { mutableStateOf("") }
    var skips by remember { mutableStateOf<SkipTimes?>(null) }
    var askedSkips by remember { mutableStateOf(false) }
    var opDone by remember { mutableStateOf(false) }
    var edDone by remember { mutableStateOf(false) }
    var countdown by remember { mutableIntStateOf(-1) }
    var nextCancelled by remember { mutableStateOf(false) }

    val save = {
        val d = player.duration
        if (ready && d > 0) Store.saveProgress(key, player.currentPosition / 1000.0, d / 1000.0, m.route, m.title, m.cover, label)
    }
    val leave = { save(); Nav.pop() }
    val goNext = {
        save()
        Nav.pop()
        Nav.replace(Route.Watch(m.id, session.ep + 1, true))
    }
    val nextSource: (String) -> Unit = { why ->
        if (index + 1 < session.candidates.size) {
            note = "$why Trying another source…"
            ready = false
            index += 1
        } else {
            LastFailure.message = "$why No other source worked. Pick one below to try again."
            Nav.pop()
        }
    }
    val currentNext by androidx.compose.runtime.rememberUpdatedState(nextSource)

    DisposableEffect(Unit) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_READY) {
                    val d = player.duration
                    val row = session.candidates.getOrNull(index)
                    // Debrid add-ons answer a blocked file with a short error clip.
                    if (row != null && StreamLogic.isDebrid(row.stream) && d in 1..39_999) { currentNext("That file is blocked."); return }
                    ready = true
                    note = ""
                }
                if (state == Player.STATE_ENDED) ended = true
            }
            override fun onPlayerError(error: PlaybackException) { currentNext("That source didn't play.") }
            override fun onTracksChanged(tracks: Tracks) {
                if (tracks.isEmpty) return
                val noVideo = tracks.containsType(C.TRACK_TYPE_VIDEO) && !tracks.isTypeSupported(C.TRACK_TYPE_VIDEO)
                val noAudio = tracks.containsType(C.TRACK_TYPE_AUDIO) && !tracks.isTypeSupported(C.TRACK_TYPE_AUDIO)
                if (noVideo) currentNext("This TV can't decode that video.")
                else if (noAudio) currentNext("This TV can't decode that audio.")
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { paused = !isPlaying && !player.playWhenReady }
        }
        player.addListener(listener)
        onDispose { save(); player.removeListener(listener); player.release() }
    }

    // Load the current source, resuming where this episode was left. A source
    // that isn't ready in 30 seconds is abandoned.
    LaunchedEffect(index) {
        val row = session.candidates.getOrNull(index) ?: return@LaunchedEffect
        val prefLang = if (Store.prefer == Audio.DUB) "en" else "ja"
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguage(prefLang).setPreferredTextLanguage("en").setSelectUndeterminedTextLanguage(true).build()
        val saved = Store.rowFor(m.route, session.ep)
        val t = saved?.optDouble("t", 0.0) ?: 0.0
        val d = saved?.optDouble("d", 0.0) ?: 0.0
        val startMs = if (t > 0 && d > 0 && t / d < 0.92) (t * 1000).toLong() else 0L
        player.setMediaItem(itemFor(row.stream, key), startMs)
        player.playWhenReady = true
        player.prepare()
        delay(30_000)
        if (!ready) currentNext("That source took too long.")
    }

    LaunchedEffect(Unit) {
        focus.requestFocus()
        var tick = 0
        while (true) {
            delay(250)
            time = player.currentPosition / 1000.0
            duration = player.duration.takeIf { it > 0 }?.div(1000.0) ?: 0.0
            if (++tick % 20 == 0) save()
            val mal = m.idMal
            if (ready && !askedSkips && duration > 1 && mal != null && !m.isMovie) {
                askedSkips = true
                skips = AniSkip.fetch(mal, session.ep, duration)
            }
            val s = skips
            if (Store.autoSkip && s != null) {
                if (!opDone && AniSkip.inside(time, s.op)) { opDone = true; player.seekTo((s.op!!.endInclusive * 1000).toLong()) }
                if (!edDone && AniSkip.inside(time, s.ed)) { edDone = true; player.seekTo((s.ed!!.endInclusive * 1000).toLong()) }
            }
            val nearEnd = duration > 30 && duration - time <= 12
            if (hasNext && Store.autoNext && !nextCancelled && countdown < 0 && (nearEnd || ended)) countdown = 8
            if (!hasNext && ended) { leave(); break }
            if (ended && (!Store.autoNext || nextCancelled)) { leave(); break }
        }
    }
    LaunchedEffect(countdown > 0) {
        while (countdown > 0) {
            delay(1000)
            if (countdown > 0) countdown -= 1
        }
        if (countdown == 0) goNext()
    }

    val s = skips
    val inOp = !opDone && AniSkip.inside(time, s?.op)
    val inEd = !edDone && AniSkip.inside(time, s?.ed)
    val poke = { overlayUntil = System.currentTimeMillis() + 3500 }

    BackHandler {
        when {
            countdown >= 0 -> { countdown = -1; nextCancelled = true }
            else -> leave()
        }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black).focusRequester(focus).focusable().onKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
            val native = e.nativeKeyEvent
            when (native.keyCode) {
                NativeKey.KEYCODE_DPAD_CENTER, NativeKey.KEYCODE_ENTER -> {
                    when {
                        native.repeatCount > 0 -> {}
                        countdown >= 0 -> countdown = 0
                        inOp -> { opDone = true; player.seekTo((s!!.op!!.endInclusive * 1000).toLong()) }
                        inEd -> { edDone = true; player.seekTo((s!!.ed!!.endInclusive * 1000).toLong()) }
                        else -> { player.playWhenReady = !player.playWhenReady; paused = !player.playWhenReady; poke() }
                    }
                    true
                }
                NativeKey.KEYCODE_MEDIA_PLAY_PAUSE, NativeKey.KEYCODE_MEDIA_PLAY, NativeKey.KEYCODE_MEDIA_PAUSE -> {
                    player.playWhenReady = !player.playWhenReady; paused = !player.playWhenReady; poke(); true
                }
                NativeKey.KEYCODE_DPAD_LEFT, NativeKey.KEYCODE_MEDIA_REWIND -> {
                    player.seekTo((player.currentPosition - if (native.repeatCount > 4) 30_000 else 10_000).coerceAtLeast(0)); poke(); true
                }
                NativeKey.KEYCODE_DPAD_RIGHT, NativeKey.KEYCODE_MEDIA_FAST_FORWARD -> {
                    player.seekTo(player.currentPosition + if (native.repeatCount > 4) 30_000 else 10_000); poke(); true
                }
                NativeKey.KEYCODE_DPAD_DOWN -> { poke(); true }
                NativeKey.KEYCODE_DPAD_UP, NativeKey.KEYCODE_MENU -> {
                    if (native.repeatCount == 0) trackMenu(context, player)
                    true
                }
                else -> false
            }
        },
    ) {
        AndroidView(
            factory = { c ->
                PlayerView(c).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = false
                    isFocusable = false
                    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    keepScreenOn = true
                    this.player = player
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        val pill: String? = when {
            countdown >= 0 -> "Episode ${session.ep + 1} in $countdown  ·  OK plays now  ·  Back cancels"
            inOp -> "Press OK to skip intro"
            inEd -> "Press OK to skip outro"
            else -> null
        }
        pill?.let {
            KText(it, 16, Color.Black, bold = true, modifier = Modifier.align(Alignment.BottomEnd).padding(32.dp).background(Orange, RoundedCornerShape(8.dp)).padding(horizontal = 16.dp, vertical = 9.dp))
        }
        if (!ready) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                KText(if (note.isEmpty()) "Starting ${m.title}…" else note, 16)
                KText(session.candidates.getOrNull(index)?.stream?.label ?: "", 12, Muted, lines = 1)
            }
        } else if (buffering) KText("Buffering…", 15, Color.White, modifier = Modifier.align(Alignment.TopEnd).padding(24.dp))

        if (ready && (paused || System.currentTimeMillis() < overlayUntil)) {
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                    .padding(start = 32.dp, end = 32.dp, top = 40.dp, bottom = 22.dp),
            ) {
                KText("${m.title}  ·  $label" + if (paused) "  ·  Paused" else "", 16, bold = true, lines = 1)
                Box(Modifier.padding(vertical = 8.dp)) { Bar(if (duration > 0) (time / duration).toFloat() else 0f) }
                KText("${clock(time)} / ${clock(duration)}     ◀ ▶ 10 seconds     ▲ audio & subtitles", 13, Color(0xFFD5D5DB))
            }
        }
    }
}

/** Lists the audio and subtitle tracks of the playing file in a native dialog. */
@OptIn(UnstableApi::class)
private fun trackMenu(context: android.content.Context, player: ExoPlayer) {
    class Choice(val label: String, val apply: () -> Unit)
    val choices = ArrayList<Choice>()
    for (group in player.currentTracks.groups) {
        val type = group.type
        if (type != C.TRACK_TYPE_AUDIO && type != C.TRACK_TYPE_TEXT) continue
        for (i in 0 until group.length) {
            if (!group.isTrackSupported(i)) continue
            val f = group.getTrackFormat(i)
            val kind = if (type == C.TRACK_TYPE_AUDIO) "Audio" else "Subtitles"
            val name = listOfNotNull(f.label, f.language).distinct().joinToString(" · ").ifEmpty { "Track ${i + 1}" }
            val on = if (group.isTrackSelected(i)) "✓ " else ""
            choices.add(Choice("$on$kind: $name") {
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(type, false)
                    .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i)).build()
            })
        }
    }
    choices.add(Choice("Subtitles: off") {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
    })
    pick(context, "Audio & subtitles", choices.map { it.label }) { choices[it].apply() }
}
