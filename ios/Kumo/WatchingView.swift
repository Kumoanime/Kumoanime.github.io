import SwiftUI

struct WatchingView: View {
    @EnvironmentObject private var model: AppModel

    private var items: [WatchItem] {
        model.watchlist.values.sorted { $0.added > $1.added }
    }

    private var recent: [ProgressItem] {
        model.continueItems()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Watching").font(Theme.display(26))
                if items.isEmpty {
                    EmptyBlock(title: "You're not watching anything yet", message: "Tap + Watching on any show to keep it here and get told when new episodes come out.")
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 16) {
                        ForEach(items) { item in
                            if let route = AppRoute.stored(item.key) {
                                NavigationLink(value: route) {
                                    PosterCard(title: item.title, poster: item.poster, subtitle: nil)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if !recent.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHead(title: "Recently watched")
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 16) {
                            ForEach(recent, id: \.route) { item in
                                if let route = AppRoute.watching(item.route, episode: item.episode) {
                                    NavigationLink(value: route) {
                                        PosterCard(title: item.title, poster: item.poster, subtitle: item.label, progress: item.d > 0 ? item.t / item.d : nil)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                Text("Your shows and progress are saved on this device.")
                    .font(Theme.body(13))
                    .foregroundStyle(Theme.muted)
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { KumoWordmark(mark: 28, word: 18) }
        }
    }
}
