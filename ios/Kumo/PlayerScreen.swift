import SwiftUI
import WebKit

struct PlayerScreen: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var session: PlaybackSession
    var onNext: () -> Void

    @StateObject private var engine = VLCEngine()
    @State private var chrome = true
    @State private var scrubbing = false
    @State private var scrub: Double = 0
    @State private var introUsed = false
    @State private var outroUsed = false
    @State private var skips: SkipTimes?
    @State private var nextCancelled = false
    @State private var countArmed = false
    @State private var menu: MenuKind?
    @State private var countdown: Int?
    @State private var countdownTask: Task<Void, Never>?
    @State private var lastSaved: Double = 0
    @State private var hideTask: Task<Void, Never>?

    private enum MenuKind: String, Identifiable {
        case audio, subtitles
        var id: String { rawValue }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if session.youtubeID != nil {
                youtube
            } else if session.request != nil {
                VLCVideoView(engine: engine).ignoresSafeArea()
            }
            if session.phase == .resolving || (engine.buffering && session.failure == nil && session.youtubeID == nil) {
                ProgressView().tint(Theme.logo).scaleEffect(1.3)
            }
            if let failure = session.failure, session.request == nil, session.phase == .failed {
                failureView(failure)
            }
            if countdown != nil {
                countdownView
            }
            if chrome && session.youtubeID == nil {
                controls
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear { wire() }
        .onChange(of: session.request, perform: { request in
            introUsed = false
            outroUsed = false
            skips = nil
            nextCancelled = false
            countArmed = false
            countdown = nil
            countdownTask?.cancel()
            guard let request else {
                engine.stop()
                return
            }
            engine.preferredSubtitle = model.prefs.subLang
            engine.play(request, rate: Float(model.prefs.speed))
            reveal()
        })
        .onChange(of: engine.seconds, perform: { time in
            guard !scrubbing else { return }
            considerSkip(time)
            saveIfNeeded(time)
        })
        .onDisappear {
            save(time: engine.seconds, duration: engine.duration)
            engine.stop()
            countdownTask?.cancel()
        }
        .confirmationDialog(menu == .audio ? "Audio" : "Subtitles", isPresented: menuPresented, titleVisibility: .visible) {
            trackButtons
        }
    }

    private var menuPresented: Binding<Bool> {
        Binding(get: { menu != nil }, set: { if !$0 { menu = nil } })
    }

    @ViewBuilder private var trackButtons: some View {
        let tracks = menu == .audio ? engine.audioTracks : engine.subtitleTracks
        ForEach(tracks) { track in
            Button(track.name) {
                if menu == .audio {
                    engine.selectAudio(track.id)
                } else {
                    engine.selectSubtitle(track.id)
                    if track.id < 0 {
                        model.setPref { $0.subLang = "off" }
                    } else {
                        model.setPref { $0.subLang = track.name }
                    }
                }
            }
        }
        Button("Close", role: .cancel) { menu = nil }
    }

    private var youtube: some View {
        YouTubeEmbed(id: session.youtubeID ?? "")
            .ignoresSafeArea()
    }

    private var controls: some View {
        ZStack {
            LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
                .onTapGesture { chrome = false }
            VStack {
                HStack(spacing: 10) {
                    Button { session.stop() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .bold))
                            .frame(width: 38, height: 38)
                            .background(.white.opacity(0.12), in: Circle())
                    }
                    .accessibilityLabel("Close player")
                    Text(session.request?.label ?? session.contextLabel)
                        .font(Theme.body(15, weight: .bold))
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                Spacer()
                HStack(spacing: 28) {
                    Button { engine.seek(to: engine.seconds - 10) } label: {
                        Image(systemName: "gobackward.10").font(.system(size: 22, weight: .semibold))
                    }
                    .accessibilityLabel("Back 10 seconds")
                    Button { engine.toggle(); reveal() } label: {
                        Image(systemName: engine.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 74, height: 74)
                            .background(Theme.logo, in: Circle())
                    }
                    .accessibilityLabel(engine.isPlaying ? "Pause" : "Play")
                    Button { engine.seek(to: engine.seconds + 10) } label: {
                        Image(systemName: "goforward.10").font(.system(size: 22, weight: .semibold))
                    }
                    .accessibilityLabel("Forward 10 seconds")
                }
                Spacer()
                VStack(spacing: 10) {
                    if showIntro || showOutro {
                        HStack {
                            Spacer()
                            if showIntro {
                                Button {
                                    introUsed = true
                                    if let end = skips?.op?.end { engine.seek(to: end) }
                                } label: {
                                    skipLabel("Skip intro »")
                                }
                            }
                            if showOutro {
                                Button {
                                    outroUsed = true
                                    if let end = skips?.ed?.end { engine.seek(to: end) }
                                } label: {
                                    skipLabel("Skip outro »")
                                }
                            }
                        }
                    }
                    HStack(spacing: 10) {
                        Text(format(scrubbing ? scrub : engine.seconds)).frame(width: 52)
                        Slider(
                            value: Binding(
                                get: { scrubbing ? scrub : engine.seconds },
                                set: { scrub = $0 }
                            ),
                            in: 0...max(engine.duration, 1),
                            onEditingChanged: { editing in
                                scrubbing = editing
                                if editing { scrub = engine.seconds }
                                if !editing { engine.seek(to: scrub) }
                            }
                        )
                        .tint(Theme.logo)
                        Text(format(engine.duration)).frame(width: 52)
                    }
                    .font(Theme.mono(12))
                    HStack(spacing: 8) {
                        chip("Audio") { menu = .audio }
                        chip("Subtitles") { menu = .subtitles }
                        chip(speedLabel) { cycleSpeed() }
                        Spacer()
                        if session.hasNext {
                            Button(action: onNext) {
                                Text("Next")
                                    .font(Theme.body(13, weight: .bold))
                                    .foregroundStyle(.black)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(Theme.logo, in: Capsule())
                            }
                            .accessibilityLabel(session.nextAccessibility)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
            .foregroundStyle(.white)
        }
    }

    private var countdownView: some View {
        VStack(spacing: 14) {
            Text("\(session.nextTitle) in")
                .font(Theme.body(18, weight: .medium))
            Text("\(countdown ?? 0)")
                .font(Theme.display(28))
                .foregroundStyle(Theme.logo)
            HStack(spacing: 10) {
                Button("Play now") { countdownTask?.cancel(); onNext() }
                    .font(Theme.body(14, weight: .bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Theme.logo, in: Capsule())
                Button("Cancel") { countdownTask?.cancel(); countdown = nil; nextCancelled = true }
                    .font(Theme.body(14, weight: .bold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.white.opacity(0.12), in: Capsule())
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black.opacity(0.72))
        .foregroundStyle(.white)
    }

    private func failureView(_ failure: PlaybackFailure) -> some View {
        VStack(spacing: 10) {
            Text(title(for: failure))
                .font(Theme.body(16, weight: .bold))
            Text(failure.message)
                .font(Theme.body(14))
                .foregroundStyle(.white.opacity(0.88))
                .multilineTextAlignment(.center)
            Button("Close") { session.stop() }
                .font(Theme.body(14, weight: .bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Theme.logo, in: Capsule())
                .padding(.top, 6)
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black.opacity(0.88))
        .foregroundStyle(.white)
    }

    private func chip(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.body(13, weight: .bold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.black.opacity(0.45), in: Capsule())
                .overlay(Capsule().stroke(.white.opacity(0.25), lineWidth: 1))
        }
    }

    private var speedLabel: String {
        let speed = model.prefs.speed
        if speed == 1 { return "1×" }
        return String(format: "%g×", speed)
    }

    private var showIntro: Bool {
        AniSkip.contains(engine.seconds, skips?.op) && !introUsed
    }

    private var showOutro: Bool {
        AniSkip.contains(engine.seconds, skips?.ed) && !outroUsed
    }

    private func skipLabel(_ title: String) -> some View {
        Text(title)
            .font(Theme.body(14, weight: .bold))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.black.opacity(0.6), in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.5), lineWidth: 1))
    }

    private func wire() {
        engine.onFailure = { message, kind in
            session.notePlayerFailure(message: message, kind: kind)
        }
        engine.onEnded = {
            save(time: engine.duration, duration: engine.duration)
            guard model.prefs.autoNext, session.hasNext, !nextCancelled, !countArmed else { return }
            countArmed = true
            startCountdown()
        }
        engine.preferredSubtitle = model.prefs.subLang
        if let request = session.request {
            engine.play(request, rate: Float(model.prefs.speed))
        }
        reveal()
    }

    private func considerSkip(_ time: Double) {
        let duration = engine.duration
        if skips == nil, duration > 1, let mal = session.progressContext?.malID, let episode = session.progressContext?.episode, mal > 0, episode > 0 {
            skips = SkipTimes()
            Task {
                let loaded = await AniSkip.fetch(malID: mal, episode: episode, duration: duration)
                if session.progressContext?.episode == episode { skips = loaded }
            }
        }
        if let op = skips?.op, AniSkip.contains(time, op), model.prefs.autoSkip, !introUsed {
            introUsed = true
            engine.seek(to: op.end)
        }
        if let ed = skips?.ed, AniSkip.contains(time, ed), model.prefs.autoSkip, !outroUsed {
            outroUsed = true
            engine.seek(to: min(ed.end, max(duration - 0.4, ed.start)))
        }
        let inOutro = skips?.ed.map { time >= $0.start } ?? false
        let nearEnd = duration > 30 && duration - time <= 12 && duration - time > 0.4
        guard (inOutro || nearEnd), model.prefs.autoNext, session.hasNext, !nextCancelled, !countArmed else { return }
        countArmed = true
        startCountdown()
    }

    private func saveIfNeeded(_ time: Double) {
        guard engine.duration > 1, time - lastSaved > 5 || time < lastSaved else { return }
        lastSaved = time
        save(time: time, duration: engine.duration)
    }

    private func save(time: Double, duration: Double) {
        guard let ctx = session.progressContext, duration > 1 else { return }
        model.saveProgress(key: ctx.key, time: time, duration: duration, route: ctx.route, title: ctx.title, poster: ctx.poster, label: ctx.shortLabel, episode: ctx.episode)
    }

    private func cycleSpeed() {
        let steps = [1.0, 1.25, 1.5, 2.0]
        let current = model.prefs.speed
        let next = steps.first { $0 > current + 0.01 } ?? 1
        model.setPref { $0.speed = next }
        engine.setRate(Float(next))
    }

    private func reveal() {
        chrome = true
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if !Task.isCancelled && engine.isPlaying { chrome = false }
        }
    }

    private func startCountdown() {
        countdownTask?.cancel()
        countdown = 5
        countdownTask = Task {
            for tick in stride(from: 5, through: 1, by: -1) {
                countdown = tick
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
            }
            countdown = nil
            onNext()
        }
    }

    private func title(for failure: PlaybackFailure) -> String {
        switch failure.kind {
        case .slate: return "The add-on sent an error"
        case .realDebrid: return "Real-Debrid didn't play that file"
        case .statusClip: return "Real-Debrid blocked this file"
        case .player: return "This source won't play"
        case .http: return "This source won't play"
        case .other: return "This source won't play"
        }
    }

    private func format(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let total = Int(seconds)
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }
}

struct YouTubeEmbed: UIViewRepresentable {
    var id: String

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        load(web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if web.url?.absoluteString.contains(id) != true { load(web) }
    }

    private func load(_ web: WKWebView) {
        guard let url = URL(string: "https://www.youtube-nocookie.com/embed/\(id)?autoplay=1&playsinline=1&rel=0") else { return }
        web.load(URLRequest(url: url))
    }
}

