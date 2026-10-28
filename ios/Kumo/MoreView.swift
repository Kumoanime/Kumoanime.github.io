import SwiftUI

struct MoreBrowseView: View {
    @EnvironmentObject private var model: AppModel
    var list: MoreList

    @State private var media: [Media] = []
    @State private var metas: [MetaPreview] = []
    @State private var page = 1
    @State private var skip = 0
    @State private var more = true
    @State private var loading = false
    @State private var hold = false
    @State private var failed = false
    @State private var pages = 0
    @State private var sentinelSeen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch list {
                case .continueWatching:
                    continueGrid
                case .catalog:
                    catalogGrid
                default:
                    mediaGrid
                }
                if loading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                if failed {
                    Button("Try again") { Task { await retry() } }
                        .font(Theme.body(15, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                } else if more && list != .continueWatching {
                    Button("Load more") { Task { await loadMore() } }
                        .font(Theme.body(15, weight: .bold))
                        .foregroundStyle(Theme.logo)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .onAppear {
                            sentinelSeen = true
                            Task { await loadMore() }
                        }
                        .onDisappear { sentinelSeen = false }
                }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if list != .continueWatching { await loadMore() }
        }
    }

    private var title: String {
        switch list {
        case .continueWatching: return "Continue watching"
        case .trending: return "Trending now"
        case .season: return currentSeason().label
        case .favourites: return "All-time favourites"
        case .catalog(_, _, _, let name): return name
        }
    }

    @ViewBuilder private var continueGrid: some View {
        let rows = model.continueAll()
        if rows.isEmpty {
            EmptyBlock(title: "Nothing in progress", message: "Start an episode and it will show up here.")
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 16) {
                ForEach(rows) { entry in
                    if let route = AppRoute.watching(entry.item.route, episode: entry.item.episode) {
                        NavigationLink(value: route) {
                            PosterCard(
                                title: entry.item.title,
                                poster: entry.item.poster,
                                subtitle: entry.item.label,
                                progress: entry.item.d > 0 ? entry.item.t / entry.item.d : nil
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder private var mediaGrid: some View {
        if media.isEmpty && !loading && !failed {
            EmptyBlock(title: "Nothing here yet", message: "This list didn't return any shows.")
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 16) {
                ForEach(media) { item in
                    NavigationLink(value: AppRoute.anime(item.id)) {
                        PosterCard(
                            title: item.title,
                            poster: item.cover,
                            subtitle: [item.seasonYear.map(String.init), item.format?.replacingOccurrences(of: "_", with: " ")].compactMap { $0 }.joined(separator: " · "),
                            rating: item.ratingText
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private var catalogGrid: some View {
        if metas.isEmpty && !loading && !failed {
            EmptyBlock(title: "Nothing in this catalogue", message: "The add-on didn't return any shows.")
        } else if case .catalog(let addon, let type, _, _) = list {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 16) {
                ForEach(metas) { meta in
                    NavigationLink(value: AppRoute.meta(addon: addon, type: meta.type.isEmpty ? type : meta.type, id: meta.id)) {
                        PosterCard(title: meta.name, poster: meta.poster, subtitle: meta.releaseInfo, rating: meta.imdbRating)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func retry() async {
        hold = false
        failed = false
        more = true
        await loadMore()
    }

    @MainActor
    private func loadMore() async {
        guard list != .continueWatching else { return }
        guard !loading, more, !hold else { return }
        loading = true
        failed = false
        var chain = false
        switch list {
        case .catalog(let addon, let type, let id, _):
            do {
                let batch = try await model.browseCatalog(addonURL: addon, type: type, id: id, skip: skip)
                let known = Set(metas.map { ($0.type.isEmpty ? type : $0.type) + ":" + $0.id })
                let fresh = batch.filter { !known.contains(($0.type.isEmpty ? type : $0.type) + ":" + $0.id) }
                metas.append(contentsOf: fresh)
                pages += 1
                skip += batch.count
                more = !fresh.isEmpty && batch.count >= 20 && pages < 30
                chain = more && sentinelSeen
            } catch {
                hold = true
                failed = true
            }
        default:
            do {
                let result = try await model.browse(list, page: page)
                let known = Set(media.map(\.id))
                let fresh = result.items.filter { !known.contains($0.id) }
                media.append(contentsOf: fresh)
                pages += 1
                page += 1
                more = result.more && !fresh.isEmpty && pages < 40
                chain = more && sentinelSeen
            } catch {
                hold = true
                failed = true
            }
        }
        loading = false
        if chain { await loadMore() }
    }
}
