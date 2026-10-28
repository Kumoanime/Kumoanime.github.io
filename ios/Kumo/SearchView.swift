import SwiftUI

struct SearchView: View {
    @EnvironmentObject private var model: AppModel
    @State private var filters = SearchFilters()
    @State private var draft = ""
    @State private var items: [Media] = []
    @State private var more = false
    @State private var page = 1
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Search").font(Theme.display(26))
                TextField("Search anime", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .font(Theme.body(16))
                    .padding(13)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.logo.opacity(draft.isEmpty ? 0 : 1), lineWidth: 1))
                    .onSubmit { apply() }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    menu("Genre", filters.genre, SearchFilters.genres.map { ($0, $0) }) { filters.genre = $0 }
                    menu("Season", filters.season, SearchFilters.seasons) { filters.season = $0 }
                    menu("Year", filters.year, SearchFilters.years.map { ($0, $0) }) { filters.year = $0 }
                    menu("Type", filters.format, SearchFilters.formats) { filters.format = $0 }
                    menu("Status", filters.status, SearchFilters.statuses) { filters.status = $0 }
                    menu("Country", filters.country, SearchFilters.countries) { filters.country = $0 }
                    menu("Min score", filters.rating, SearchFilters.ratings) { filters.rating = $0 }
                    menu("Source", filters.source, SearchFilters.sources) { filters.source = $0 }
                    menu("Episodes", filters.episodes, SearchFilters.episodeBands) { filters.episodes = $0 }
                    menu(filters.sort == nil ? "Sort: popular" : "Sort", filters.sort, SearchFilters.sorts) { filters.sort = $0 }
                }
                HStack(spacing: 8) {
                    Button("Filter") { apply() }
                        .font(Theme.body(15, weight: .bold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Theme.logo, in: RoundedRectangle(cornerRadius: 12))
                    if filters.activeCount > 0 {
                        Button("Clear \(filters.activeCount) filter\(filters.activeCount == 1 ? "" : "s")") {
                            let q = filters.q
                            filters = SearchFilters()
                            filters.q = q
                            apply()
                        }
                        .font(Theme.body(15, weight: .bold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Theme.raise, in: RoundedRectangle(cornerRadius: 12))
                    }
                    Button(filters.excludeWatching ? "Showing unwatched" : "Hide my Watching") {
                        filters.excludeWatching.toggle()
                    }
                    .font(Theme.body(14))
                    .foregroundStyle(filters.excludeWatching ? Theme.logo : Theme.muted)
                }
                if loading && items.isEmpty {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        ForEach(0..<6, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 10).fill(Theme.surface).aspectRatio(2 / 3, contentMode: .fit)
                        }
                    }
                } else if failed {
                    EmptyBlock(title: "Search isn't working", message: "Couldn't reach AniList. Check your connection and try again.")
                } else if items.isEmpty && !loading {
                    EmptyBlock(title: "Nothing matches", message: "Try fewer filters, or the show's Japanese or English title.")
                } else {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 14) {
                        ForEach(items) { media in
                            NavigationLink(value: AppRoute.anime(media.id)) {
                                PosterCard(title: media.title, poster: media.cover, subtitle: media.seasonYear.map(String.init), rating: media.ratingText)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if more {
                        Button(loading ? "Loading…" : "Load more") {
                            guard !loading else { return }
                            page += 1
                            Task { await run(append: true) }
                        }
                        .font(Theme.body(15, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.raise, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .navigationBarLeading) { KumoWordmark(mark: 28, word: 18) } }
        .task { await run(append: false) }
    }

    private func menu(_ title: String, _ value: String?, _ options: [(String, String)], set: @escaping (String?) -> Void) -> some View {
        Menu {
            Button(title) { set(nil) }
            ForEach(options, id: \.0) { option in
                Button(option.1) { set(option.0) }
            }
        } label: {
            HStack {
                Text(options.first { $0.0 == value }?.1 ?? title)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold))
            }
            .font(Theme.body(15))
            .foregroundStyle(value == nil ? Theme.muted : Theme.ink)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(value == nil ? Theme.line : Theme.logo, lineWidth: 1))
        }
    }

    private func apply() {
        filters.q = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        page = 1
        Task { await run(append: false) }
    }

    private func run(append: Bool) async {
        loading = true
        if !append { page = max(page, 1) }
        do {
            let result = try await model.search(page: page, filters: filters)
            items = append ? items + result.items : result.items
            more = result.more
            failed = false
        } catch {
            if !append { failed = true; items = [] }
        }
        loading = false
    }
}
