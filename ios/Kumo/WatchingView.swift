import SwiftUI

struct WatchingView: View {
    @EnvironmentObject private var model: AppModel

    private var recent: [ProgressItem] {
        model.continueItems()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Watching").font(Theme.display(26))
                if recent.isEmpty {
                    if model.watchlist.isEmpty {
                        EmptyBlock(title: "You're not watching anything yet", message: "Tap + Watching on any show to keep it on Home and get told when new episodes come out.")
                    } else {
                        EmptyBlock(title: "Nothing in progress", message: "Your shows are on Home. Start an episode and it will show up here.")
                    }
                } else {
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
                Text("Your shows are on Home. Progress is saved on this device.")
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
