package app.kumo.tv

import android.net.Uri
import android.view.KeyEvent as NativeKey
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

val SubSizes = listOf("Small", "Medium", "Large")
private val SubFractions = listOf(0.043f, 0.0533f, 0.07f)

class PlaySession(val media: Media, val ep: Int, val candidates: List<StreamRow>, val subtitles: List<Subtitle>, val ids: ShowIds)

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
private fun itemFor(s: Stream, id: String, extra: List<Subtitle>): MediaItem {
    val url = s.url ?: ""
    val b = MediaItem.Builder().setUri(url).setMediaId(id)
    if (url.substringBefore('?').lowercase().endsWith(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8)
    val subs = (s.subtitles + extra).distinctBy { it.url }.take(20).map { sub ->
        val path = sub.url.lowercase()
        val mime = when {
            path.contains(".vtt") || path.contains("format=vtt") -> MimeTypes.TEXT_VTT
            path.contains(".ass") || path.contains(".ssa") -> MimeTypes.TEXT_SSA
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
    var skips by remember { mutableStateOf<SkipTimes?>(null) }
    var opDone by remember { mutableStateOf(false) }
    var edDone by remember { mutableStateOf(false) }
    var countdown by remember { mutableIntStateOf(-1) }
    var nextCancelled by remember { mutableStateOf(false) }
    var recapDone by remember { mutableStateOf(false) }
    var episodeInfo by remember { mutableStateOf<Map<Int, EpisodeInfo>>(emptyMap()) }
    val info = episodeInfo[session.ep]
    // Auto Next's target. Moves past filler when that's turned on.
    var nextEp by remember { mutableIntStateOf(session.ep + 1) }
    val hasNext = { !m.isMovie && nextEp <= m.episodeCount }
    LaunchedEffect(Unit) { if (!m.isMovie) episodeInfo = AniList.episodes(m.id) }
    LaunchedEffect(Unit) {
        if (m.isMovie || !Store.skipFiller) return@LaunchedEffect
        val filler = Filler.episodes(m.idMal)
        var n = session.ep + 1
        while (n in filler) n++
        nextEp = n
    }

    val save = {
        val d = player.duration
        if (ready && d > 0) Store.saveProgress(key, player.currentPosition / 1000.0, d / 1000.0, m.route, m.title, m.cover, label)
    }
    val leave = { save(); Nav.pop(); if (Nav.stack.last() is Route.Watch) Nav.pop() }
    val goNext = {
        save()
        Nav.pop()
        val next = Route.Watch(m.id, nextEp, true)
        if (Nav.stack.last() is Route.Watch) Nav.replace(next) else Nav.push(next)
    }
    val nextSource: (String) -> Unit = { why ->
        if (index + 1 < session.candidates.size) {
            ready = false
            index += 1
        } else {
            LastFailure.message = "$why No other source worked. Try again, or choose Sub, Dub or Other."
            Nav.pop()
            if (Nav.stack.last() is Route.Watch) Nav.pop()
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
        val prefLang = Store.audioLang(m.id) ?: if ((Store.kindFor(m.id) ?: Store.prefer) == Audio.DUB) "en" else "ja"
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguage(prefLang).setPreferredTextLanguage(Store.subLang(m.id) ?: "en").setSelectUndeterminedTextLanguage(true)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, Store.subOff(m.id)).build()
        val saved = Store.rowFor(m.route, session.ep)
        val t = saved?.optDouble("t", 0.0) ?: 0.0
        val d = saved?.optDouble("d", 0.0) ?: 0.0
        val startMs = if (t > 0 && d > 0 && t / d < 0.92) (t * 1000).toLong() else 0L
        player.setMediaItem(itemFor(row.stream, key, session.subtitles), startMs)
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
            val s = skips
            // Rewinding to before the intro or outro offers the skip again.
            if (s?.op != null && time < s.op.start) opDone = false
            if (s?.ed != null && time < s.ed.start) edDone = false
            if (s?.recap != null && time < s.recap.start) recapDone = false
            if (Store.autoSkip && s != null) {
                if (!opDone && SkipSources.inside(time, s.op)) { opDone = true; player.seekTo((s.op!!.endInclusive * 1000).toLong()) }
                if (!recapDone && SkipSources.inside(time, s.recap)) { recapDone = true; player.seekTo((s.recap!!.endInclusive * 1000).toLong()) }
                if (!edDone && SkipSources.inside(time, s.ed)) { edDone = true; player.seekTo((s.ed!!.endInclusive * 1000).toLong()) }
            }
            val nearEnd = duration > 30 && duration - time <= 12
            if (hasNext() && Store.autoNext && !nextCancelled && countdown < 0 && (nearEnd || ended)) countdown = 8
            if (!hasNext() && ended) { leave(); break }
            if (ended && (!Store.autoNext || nextCancelled)) { leave(); break }
        }
    }
    // Skip times are looked up fresh on every play. While any are missing, check
    // again every two minutes in case someone submits them.
    LaunchedEffect(ready) {
        if (!ready || m.isMovie) return@LaunchedEffect
        while (true) {
            val d = player.duration / 1000.0
            if (d > 1) {
                val found = SkipSources.find(session.ids, session.ep, d)
                if (found.op != null || found.ed != null) skips = found
                if (found.op != null && found.ed != null) break
            }
            delay(120_000)
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
    val inOp = !opDone && SkipSources.inside(time, s?.op)
    val inEd = !edDone && SkipSources.inside(time, s?.ed)
    val inRecap = !recapDone && SkipSources.inside(time, s?.recap)
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
                        inRecap -> { recapDone = true; player.seekTo((s!!.recap!!.endInclusive * 1000).toLong()) }
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
                    if (native.repeatCount == 0) trackMenu(context, player, m.id)
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
                    // White text with a black outline and no box behind it. Embedded
                    // styles are ignored because anime subtitles often bring their own box.
                    subtitleView?.apply {
                        setStyle(CaptionStyleCompat(android.graphics.Color.WHITE, android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_OUTLINE, android.graphics.Color.BLACK, null))
                        setApplyEmbeddedStyles(false)
                        setApplyEmbeddedFontSizes(false)
                    }
                }
            },
            update = { view ->
                Store.version  // Applies a size or position change straight away.
                view.subtitleView?.setFractionalTextSize(SubFractions[Store.subSizeFor(m.id)])
                view.subtitleView?.setBottomPaddingFraction(if (Store.subHighFor(m.id)) 0.18f else 0.07f)
            },
            modifier = Modifier.fillMaxSize(),
        )

        val pill: String? = when {
            countdown >= 0 -> null
            inRecap -> "Skip recap"
            inOp -> "Skip intro"
            inEd -> "Skip outro"
            else -> null
        }
        val controls = ready && (paused || System.currentTimeMillis() < overlayUntil)
        if (ready && paused) Box(Modifier.fillMaxSize().background(Color(0x99000000)))
        if (!ready) {
            CircularProgressIndicator(Modifier.align(Alignment.Center).size(40.dp), color = Orange, strokeWidth = 3.dp)
        } else if (buffering) {
            CircularProgressIndicator(Modifier.align(Alignment.Center).size(40.dp), color = Color.White, strokeWidth = 3.dp)
        } else if (paused) {
            Box(Modifier.align(Alignment.Center).size(72.dp).clip(CircleShape).background(Color(0x80000000)), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.PlayArrow, "Paused", Modifier.size(44.dp), tint = Color.White)
            }
        }
        if (controls) {
            Column(
                Modifier.align(Alignment.TopStart).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color(0xB3000000), Color.Transparent)))
                    .padding(start = 36.dp, end = 36.dp, top = 24.dp, bottom = 44.dp),
            ) {
                KText(m.title, 20, bold = true, lines = 1)
                KText(listOfNotNull(label, info?.title).joinToString("  ·  "), 13, Color(0xFFD5D5DB), lines = 1)
            }
            if (paused) info?.overview?.let {
                KText(it, 14, Color(0xFFE2E2E8), lines = 4, modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth(0.55f).padding(start = 36.dp, bottom = 96.dp))
            }
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                    .padding(start = 36.dp, end = 36.dp, top = 56.dp, bottom = 22.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    KText(clock(time), 13, bold = true)
                    Box(Modifier.weight(1f)) { Bar(if (duration > 0) (time / duration).toFloat() else 0f) }
                    KText(clock(duration), 13, Color(0xFFD5D5DB))
                }
                KText("▲  Audio and subtitles", 12, Muted, modifier = Modifier.padding(top = 9.dp))
            }
        }
        if (countdown >= 0) {
            val up = episodeInfo[nextEp]
            Row(
                Modifier.align(Alignment.BottomEnd).padding(end = 36.dp, bottom = 36.dp).width(420.dp).clip(RoundedCornerShape(14.dp)).background(Color(0xE6101014)).padding(10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                AsyncImage(up?.image ?: m.banner ?: m.cover, null, Modifier.size(150.dp, 84.dp).clip(RoundedCornerShape(9.dp)).background(Color(0xFF26262C)), contentScale = ContentScale.Crop)
                Column(Modifier.weight(1f)) {
                    KText("Up next  ·  Episode $nextEp", 12, Orange, bold = true, lines = 1)
                    KText(up?.title ?: m.title, 15, bold = true, lines = 2)
                    KText("Plays in $countdown   ·   OK now   ·   Back to cancel", 11, Muted, lines = 1, modifier = Modifier.padding(top = 3.dp))
                }
            }
        }
        pill?.let {
            KText(it, 15, Color.Black, bold = true, modifier = Modifier.align(Alignment.BottomEnd).padding(end = 36.dp, bottom = if (controls) 84.dp else 36.dp).background(Color.White, RoundedCornerShape(24.dp)).padding(horizontal = 22.dp, vertical = 10.dp))
        }
    }
}

/** Lists the audio and subtitle tracks of the playing file in a native dialog. */
@OptIn(UnstableApi::class)
private fun trackMenu(context: android.content.Context, player: ExoPlayer, show: Int) {
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
                if (type == C.TRACK_TYPE_AUDIO) f.language?.let { Store.setAudioLang(show, it) } else Store.setSubLang(show, f.language)
            })
        }
    }
    choices.add(Choice("Subtitles: off") {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
        Store.setSubOff(show)
    })
    val size = Store.subSizeFor(show)
    val high = Store.subHighFor(show)
    choices.add(Choice("Subtitle size: ${SubSizes[size]}") { Store.setSubSize(show, (size + 1) % SubSizes.size) })
    choices.add(Choice(if (high) "Subtitle position: Higher" else "Subtitle position: Bottom") { Store.setSubHigh(show, !high) })
    pick(context, "Audio & subtitles", choices.map { it.label }) { choices[it].apply() }
}
