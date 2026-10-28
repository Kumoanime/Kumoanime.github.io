import SwiftUI

struct WatchingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var status: ListStatus = .watching

    private var items: [WatchItem] {
        model.items(status: status)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(ListStatus.allCases) { row in
                            Button {
                                status = row
                            } label: {
                                Text(row.label)
                                    .font(Theme.body(13, weight: .bold))
                                    .foregroundStyle(status == row ? Color.black : Theme.muted)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(status == row ? Theme.logo : Theme.surface, in: Capsule())
                                    .overlay(Capsule().stroke(Theme.line, lineWidth: status == row ? 0 : 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(status == row ? .isSelected : [])
                        }
                    }
                }
                Text(status.label).font(Theme.display(26))
                if items.isEmpty {
                    EmptyBlock(title: emptyTitle, message: emptyMessage)
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
                Text("Your shows are saved on this device. + Watching still adds to Watching only.")
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

    private var emptyTitle: String {
        switch status {
        case .watching: return "You're not watching anything yet"
        case .planning: return "Nothing planned yet"
        case .completed: return "Nothing completed yet"
        case .hold: return "Nothing on hold"
        case .dropped: return "Nothing dropped"
        }
    }

    private var emptyMessage: String {
        switch status {
        case .watching: return "Tap + Watching on any show to keep it here and get told when new episodes come out."
        case .planning: return "Choose Plan to Watch on a show page to keep it here."
        case .completed: return "Choose Completed on a show page when you finish it."
        case .hold: return "Choose On Hold on a show page to park it here."
        case .dropped: return "Choose Dropped on a show page to keep it out of Watching."
        }
    }
}
