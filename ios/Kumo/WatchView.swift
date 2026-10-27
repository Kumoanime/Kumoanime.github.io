import SwiftUI

struct WatchView: View {
    @EnvironmentObject private var model: AppModel
    var anilistID: Int
    var initialEpisode: Int
    var forceAuto: Bool

    @StateObject private var session = PlaybackSession()
    @State private var media: Media?
    @State private var episode = 1
    @State private var rows: [StreamRow] = []
    @State private var reports: [AddonReport] = []
    @State private var context: WatchContext?
    @State private var loading = true
    @State private var failed = false
    @State private var loadToken = 0

    var body: some View {
        ScrollView {
            if let media {
                body(media)
            } else if failed {
                EmptyBlock(title: "Couldn't load this episode", message: "AniList didn't respond. Go back and try again.")
                    .padding(16)
            } else {
                RoundedRectangle(cornerRadius: 14).fill(Theme.surface).aspectRatio(16 / 9, contentMode: .fit).padding(16)
            }
        }
        .background(Theme.bg)
        .navigationTitle(media?.title ?? "Watch")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: Binding(
            get: { session.showsPlayer },
            set: { if !$0 { session.stop() } }
        )) {
            PlayerScreen(session: session) {
                let count = media?.episodeCount ?? episode
                guard episode < count else { return }
                Task { await reload(number: episode + 1, forceAuto: true, keepPlayer: true) }
            }
            .environmentObject(model)
        }
        .task {
            episode = initialEpisode
            session.bind(model)
            await reload(number: initialEpisode, forceAuto: forceAuto, keepPlayer: false)
        }
    }

    @ViewBuilder private func body(_ media: Media) -> some View {
        let route = model.route(for: media.id)
        VStack(alignment: .leading, spacing: 12) {
            ZStack {
                PosterImage(url: media.banner ?? media.cover).opacity(0.55)
                if loading {
                    ProgressView().tint(Theme.logo)
                } else {
                    Button {
                        guard let context else { return }
                        session.bind(model)
                        session.playAuto(rows: rows, context: context)
                    } label: {
                        Image(systemName: "play.fill")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 84, height: 84)
                            .background(Theme.logo, in: Circle())
                            .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 4))
                    }
                    .accessibilityLabel("Play")
                }
                if !session.status.isEmpty {
                    Text(session.status)
                        .font(Theme.body(13))
                        .foregroundStyle(.white)
                        .shadow(radius: 4)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 12)
                }
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 14))

            HStack {
                HStack(spacing: 14) {
                    PrefToggle(title: "Auto Play", on: model.prefs.autoPlay) { model.setPref { $0.autoPlay.toggle() } }
                    if !media.isMovie {
                        PrefToggle(title: "Auto Next", on: model.prefs.autoNext) { model.setPref { $0.autoNext.toggle() } }
                    }
                    PrefToggle(title: "Auto Skip intro", on: model.prefs.autoSkip) { model.setPref { $0.autoSkip.toggle() } }
                }
                Spacer()
                if !media.isMovie {
                    HStack(spacing: 6) {
                        navButton("Prev", enabled: episode > 1) { Task { await reload(number: episode - 1, forceAuto: true, keepPlayer: false) } }
                        navButton("Next", enabled: episode < media.episodeCount) { Task { await reload(number: episode + 1, forceAuto: true, keepPlayer: false) } }
                    }
                }
            }
            .padding(12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))

            Text(watchingLine(media))
                .font(Theme.body(14))
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))

            if let failure = session.failure, !session.showsPlayer {
                Text(failure.message)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            }

            if loading && rows.isEmpty {
                Text("Asking your add-ons…").font(Theme.body(14)).foregroundStyle(Theme.muted)
            } else {
                SourceList(rows: rows, selected: session.selectedIndex) { row in
                    guard let context else { return }
                    session.bind(model)
                    session.playTapped(rows: rows, index: row.index, context: context)
                }
            }

            if !reports.isEmpty {
                DisclosureGroup("Add-on status (\(reports.count))") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(reports) { report in
                            Text("\(report.name) \(report.why).")
                                .font(Theme.body(13))
                                .foregroundStyle(Theme.muted)
                        }
                    }
                    .padding(.top, 8)
                }
                .font(Theme.body(14, weight: .bold))
                .tint(Theme.ink)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            }

            if let note = airing(media) {
                Text("🔔 \(note)")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            }

            if !media.isMovie {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHead(title: "Episodes")
                    EpisodeGrid(
                        count: media.episodeCount,
                        current: episode,
                        seen: { model.fraction(route: route, episode: $0) > 0.92 },
                        fraction: { model.fraction(route: route, episode: $0) }
                    ) { number in
                        Task { await reload(number: number, forceAuto: false, keepPlayer: false) }
                    }
                }
            }
        }
        .padding(16)
    }

    private func navButton(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.body(14, weight: .bold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Theme.raise, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }

    private func watchingLine(_ media: Media) -> AttributedString {
        var text = AttributedString("You're watching ")
        var bold = AttributedString(media.isMovie ? media.title : "Episode \(episode)")
        bold.foregroundColor = UIColor(Theme.logo)
        bold.font = .boldSystemFont(ofSize: 14)
        text.append(bold)
        if !media.isMovie {
            text.append(AttributedString(" of \(media.title). If a source doesn't work, try another one below."))
        } else {
            text.append(AttributedString(". If a source doesn't work, try another one below."))
        }
        return text
    }

    private func airing(_ media: Media) -> String? {
        guard let episode = media.nextEpisode, let at = media.nextAiringAt else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(at))
        return "Episode \(episode) arrives \(date.formatted(.dateTime.weekday(.wide).day().month(.wide).hour().minute()))."
    }

    private func reload(number: Int, forceAuto: Bool, keepPlayer: Bool) async {
        loadToken += 1
        let token = loadToken
        episode = number
        if !keepPlayer { session.stop() }
        loading = true
        do {
            let loaded = try await model.media(id: anilistID)
            guard token == loadToken else { return }
            media = loaded
            let result = await model.fetchStreams(media: loaded, episode: number)
            guard token == loadToken else { return }
            rows = result.rows
            reports = result.reports
            context = result.context
            loading = false
            let start = forceAuto || model.prefs.autoPlay
            if start && !result.rows.isEmpty {
                session.bind(model)
                session.playAuto(rows: result.rows, context: result.context)
            }
        } catch {
            guard token == loadToken else { return }
            failed = media == nil
            loading = false
        }
    }
}
