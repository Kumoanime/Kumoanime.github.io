import SwiftUI

struct AnimeDetailView: View {
    @EnvironmentObject private var model: AppModel
    var id: Int
    @State private var media: Media?
    @State private var failed = false
    @State private var trailer: String?

    var body: some View {
        ScrollView {
            if let media {
                content(media)
            } else if failed {
                EmptyBlock(title: "Couldn't load this show", message: "AniList didn't respond. Go back and try again.")
                    .padding(16)
            } else {
                RoundedRectangle(cornerRadius: 16).fill(Theme.surface).frame(height: 260).padding(16)
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: Binding(
            get: { trailer.map { TrailerItem(id: $0) } },
            set: { trailer = $0?.id }
        )) { item in
            ZStack(alignment: .topLeading) {
                Color.black.ignoresSafeArea()
                YouTubeEmbed(id: item.id).ignoresSafeArea()
                Button { trailer = nil } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(.black.opacity(0.45), in: Circle())
                }
                .padding()
            }
        }
        .task { await load() }
    }

    @ViewBuilder private func content(_ media: Media) -> some View {
        let route = model.route(for: media.id)
        let next = model.nextEpisode(route: route, count: media.episodeCount)
        VStack(alignment: .leading, spacing: 16) {
            ZStack(alignment: .bottomLeading) {
                PosterImage(url: media.banner ?? media.cover)
                    .frame(height: 180)
                    .frame(maxWidth: .infinity)
                    .opacity(0.55)
                HStack(alignment: .bottom, spacing: 16) {
                    PosterImage(url: media.cover)
                        .frame(width: 110, height: 165)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .shadow(radius: 12)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(media.title).font(Theme.display(26)).fixedSize(horizontal: false, vertical: true)
                        if let rating = media.ratingText {
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text("★ \(rating)").font(Theme.display(22)).foregroundStyle(Theme.star)
                                Text("/10 on AniList").font(Theme.body(12)).foregroundStyle(Theme.muted)
                            }
                        }
                        Text(facts(media))
                            .font(Theme.mono(11))
                            .foregroundStyle(Theme.muted)
                            .textCase(.uppercase)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .offset(y: 36)
            }
            .padding(.bottom, 36)
            if let synopsis = media.synopsis, !synopsis.isEmpty {
                Text(synopsis).font(Theme.body(15)).foregroundStyle(Theme.ink.opacity(0.9))
                    .padding(.horizontal, 16)
            }
            HStack(spacing: 8) {
                NavigationLink(value: AppRoute.watch(id: media.id, episode: media.isMovie ? 1 : next, auto: true)) {
                    Text(media.isMovie ? "▶  Play" : "▶  Play episode \(next)")
                        .font(Theme.body(15, weight: .bold))
                        .foregroundStyle(Theme.accentInk)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                if let trailerID = media.trailerYouTube {
                    Button { trailer = trailerID } label: {
                        Text("Trailer")
                            .font(Theme.body(15, weight: .bold))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Theme.raise, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                Button {
                    model.toggleWatch(key: route, title: media.title, poster: media.cover)
                } label: {
                    Text(model.watchlist[route] == nil ? "+ Watching" : "✓ Watching")
                        .font(Theme.body(15, weight: .bold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Theme.raise, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 16)
            if !media.isMovie {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHead(title: "Episodes", note: airing(media))
                    EpisodeGrid(count: media.episodeCount, current: 0, seen: { model.fraction(route: route, episode: $0) > 0.92 }, fraction: { model.fraction(route: route, episode: $0) }) { number in
                        model.pendingRoute = .watch(id: media.id, episode: number, auto: false)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .padding(.bottom, 24)
    }

    private func facts(_ media: Media) -> String {
        [media.studio, media.seasonYear.map(String.init), media.format?.replacingOccurrences(of: "_", with: " "), media.episodes.map { "\($0) eps" }]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private func airing(_ media: Media) -> String? {
        guard let episode = media.nextEpisode, let at = media.nextAiringAt else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(at))
        return "Ep \(episode) airs \(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))"
    }

    private func load() async {
        do { media = try await model.media(id: id) } catch { failed = true }
    }
}

private struct TrailerItem: Identifiable {
    var id: String
}
