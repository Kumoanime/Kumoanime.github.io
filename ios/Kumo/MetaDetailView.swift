import SwiftUI

struct MetaDetailView: View {
    @EnvironmentObject private var model: AppModel
    var addonURL: String
    var type: String
    var metaID: String

    @StateObject private var session = PlaybackSession()
    @State private var meta: MetaPreview?
    @State private var failed = false
    @State private var videoID: String?
    @State private var rows: [StreamRow] = []
    @State private var context: WatchContext?
    @State private var loadingStreams = false

    var body: some View {
        ScrollView {
            if let meta {
                content(meta)
            } else if failed {
                EmptyBlock(title: "Couldn't open this title", message: "The add-on didn't return details. It may be offline.")
                    .padding(16)
            } else {
                ProgressView().tint(Theme.logo).padding(40)
            }
        }
        .background(Theme.bg)
        .navigationTitle(meta?.name ?? "Title")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .fullScreenCover(isPresented: Binding(
            get: { session.showsPlayer },
            set: { if !$0 { session.stop() } }
        )) {
            PlayerScreen(session: session) { playNext() }
                .environmentObject(model)
        }
    }

    @ViewBuilder private func content(_ meta: MetaPreview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ZStack(alignment: .bottomLeading) {
                PosterImage(url: meta.background ?? meta.poster)
                    .frame(maxWidth: .infinity)
                    .frame(height: 220)
                    .clipped()
                LinearGradient(colors: [.clear, Theme.bg], startPoint: .center, endPoint: .bottom)
            }
            HStack(alignment: .top, spacing: 12) {
                PosterImage(url: meta.poster)
                    .frame(width: 92, height: 138)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 6) {
                    Text(meta.name).font(Theme.display(22))
                    Text([meta.releaseInfo, meta.imdbRating.map { "★ \($0)" }, meta.genres.prefix(3).joined(separator: " · ")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(Theme.body(13))
                        .foregroundStyle(Theme.muted)
                    Button(model.isWatching(watchKey) ? "✓ Watching" : "+ Watching") {
                        model.toggleWatch(key: watchKey, title: meta.name, poster: meta.poster)
                    }
                    .font(Theme.body(14, weight: .bold))
                    .foregroundStyle(model.isWatching(watchKey) ? Color.black : Theme.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(model.isWatching(watchKey) ? Theme.logo : Theme.raise, in: Capsule())
                    .overlay(Capsule().stroke(Theme.line, lineWidth: model.isWatching(watchKey) ? 0 : 1))
                }
            }
            .padding(.horizontal, 16)
            if let description = meta.description?.nilIfEmpty {
                Text(description)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.ink.opacity(0.9))
                    .padding(.horizontal, 16)
            }
            if !meta.videos.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHead(title: "Episodes")
                    ForEach(meta.videos) { video in
                        Button {
                            videoID = video.id
                            Task { await loadStreams(meta, video: video, auto: false) }
                        } label: {
                            HStack {
                                Text(video.title).font(Theme.body(14, weight: video.id == videoID ? .bold : .regular)).lineLimit(1)
                                Spacer()
                                if video.id == videoID {
                                    Image(systemName: "play.fill").font(.system(size: 11)).foregroundStyle(Theme.logo)
                                }
                            }
                            .padding(12)
                            .background(video.id == videoID ? Theme.raise : Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            } else {
                Button("Play") {
                    Task { await loadStreams(meta, video: nil, auto: true) }
                }
                .buttonStyle(OrangeButtonStyle())
                .padding(.horizontal, 16)
            }
            if loadingStreams {
                ProgressView().tint(Theme.logo).padding(.horizontal, 16)
            }
            if context != nil || !rows.isEmpty {
                SourceList(rows: rows, selected: session.selectedIndex) { row in
                    guard let context else { return }
                    session.bind(model)
                    session.playTapped(rows: rows, index: row.index, context: context)
                }
                .padding(.horizontal, 16)
                if rows.isEmpty && !loadingStreams {
                    EmptyBlock(title: "No sources", message: "None of your add-ons returned a stream for this.")
                        .padding(.horizontal, 16)
                }
            }
        }
        .padding(.bottom, 20)
    }

    private var watchKey: String { "m/\(addonURL)|\(type)|\(metaID)" }

    private func load() async {
        if let loaded = await model.loadMeta(addonURL: addonURL, type: type, id: metaID) {
            meta = loaded
            if loaded.videos.isEmpty {
                await loadStreams(loaded, video: nil, auto: model.prefs.autoPlay)
            }
        } else {
            failed = true
        }
    }

    private func loadStreams(_ meta: MetaPreview, video: MetaVideo?, auto: Bool) async {
        loadingStreams = true
        let result = await model.fetchMetaStreams(addonURL: addonURL, meta: meta, video: video)
        var ctx = result.context
        if let video, let next = nextVideo(after: video, in: meta) {
            ctx.hasNext = true
            ctx.nextLabel = next.title
        }
        rows = result.rows
        context = ctx
        loadingStreams = false
        guard auto, !result.rows.isEmpty else { return }
        session.bind(model)
        session.playAuto(rows: result.rows, context: ctx)
    }

    private func playNext() {
        guard let meta, let videoID, let current = meta.videos.first(where: { $0.id == videoID }),
              let next = nextVideo(after: current, in: meta) else { return }
        self.videoID = next.id
        Task { await loadStreams(meta, video: next, auto: true) }
    }

    private func nextVideo(after video: MetaVideo, in meta: MetaPreview) -> MetaVideo? {
        guard let index = meta.videos.firstIndex(where: { $0.id == video.id }) else { return nil }
        let next = meta.videos.index(after: index)
        guard next < meta.videos.endIndex else { return nil }
        return meta.videos[next]
    }
}
