import SwiftUI

struct PosterCard: View {
    var title: String
    var poster: String?
    var subtitle: String?
    var rating: String?
    var progress: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomLeading) {
                PosterImage(url: poster)
                    .frame(width: 128, height: 192)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                if let rating {
                    Text("★ \(rating)")
                        .font(Theme.mono(11))
                        .foregroundStyle(Theme.star)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(.black.opacity(0.72), in: Capsule())
                        .padding(6)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
                if let progress, progress > 0 {
                    GeometryReader { geo in
                        Rectangle()
                            .fill(Theme.accent)
                            .frame(width: geo.size.width * progress, height: 3)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                }
            }
            .frame(width: 128, height: 192)
            Text(title)
                .font(Theme.body(13, weight: .bold))
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
                .frame(width: 128, alignment: .leading)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(Theme.body(12))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .frame(width: 128, alignment: .leading)
            }
        }
    }
}

struct PosterImage: View {
    var url: String?

    var body: some View {
        Theme.raise.overlay {
            if let url, let parsed = URL(string: url) {
                AsyncImage(url: parsed) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Color.clear
                    }
                }
            }
        }
        .clipped()
    }
}

struct SectionHead: View {
    var title: String
    var note: String?
    var more: AppRoute? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(title).font(Theme.display(18))
            Spacer(minLength: 8)
            if let note {
                Text(note.uppercased())
                    .font(Theme.mono(11))
                    .foregroundStyle(Theme.muted)
            }
            if let more {
                NavigationLink(value: more) {
                    Text("More")
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.logo)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("More \(title)")
            }
        }
    }
}

struct MoreTile: View {
    var body: some View {
        Text("More")
            .font(Theme.display(16))
            .foregroundStyle(Theme.logo)
            .frame(width: 128, height: 192)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [5])))
            .accessibilityLabel("More")
    }
}

struct EmptyBlock: View {
    var title: String
    var message: String

    var body: some View {
        VStack(spacing: 6) {
            Text(title).font(Theme.display(17)).foregroundStyle(Theme.ink)
            Text(message)
                .font(Theme.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 18)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [5])))
    }
}

struct Rail<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) { content }
        }
    }
}

struct SkeletonRail: View {
    var body: some View {
        Rail {
            ForEach(0..<6, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 10).fill(Theme.surface).frame(width: 128, height: 192)
            }
        }
    }
}

struct Dock: View {
    @Binding var tab: Tab

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 0) {
                item(.search, "magnifyingglass")
                item(.home, "house.fill")
                item(.watching, "tv.fill")
                item(.addons, "puzzlepiece.extension.fill")
            }
            .padding(.top, 6)
            .padding(.bottom, 4)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }

    private func item(_ value: Tab, _ symbol: String) -> some View {
        let on = tab == value
        return Button {
            tab = value
        } label: {
            VStack(spacing: 3) {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .semibold))
                Text(value.title)
                    .font(Theme.body(10, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(on ? Theme.logo : Theme.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(value.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct SourceList: View {
    @EnvironmentObject private var model: AppModel
    var rows: [StreamRow]
    var selected: Int?
    var onSelect: (StreamRow) -> Void

    var body: some View {
        let groups = StreamLogic.displayGroups(rows, prefer: model.prefs.audio == "dub" ? .dub : .sub)
        VStack(alignment: .leading, spacing: 16) {
            if rows.isEmpty {
                EmptyBlock(title: "No sources for this episode", message: "None of your add-ons have it yet. Try again later, or install one from Add-ons.")
            }
            ForEach(groups, id: \.1) { _, label, list in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text(label == "SUB" ? "CC" : (label == "DUB" ? "DUB" : "▶"))
                            .font(Theme.mono(10))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Theme.ink, in: RoundedRectangle(cornerRadius: 4))
                            .foregroundStyle(.black)
                        Text(label).font(Theme.body(15, weight: .bold))
                    }
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                        ForEach(list) { row in
                            sourceButton(row)
                        }
                    }
                }
            }
        }
    }

    private func sourceButton(_ row: StreamRow) -> some View {
        let on = selected == row.index
        let cached = StreamLogic.isCached(row.stream)
        let kind = StreamLogic.kindLabel(row.stream)
        return Button { onSelect(row) } label: {
            HStack(alignment: .center, spacing: 10) {
                Text(cached ? "⚡" : "▶")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 26, height: 26)
                    .background(on ? Color.black : Theme.raise, in: Circle())
                    .foregroundStyle(on ? Theme.logo : Theme.ink)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.stream.headline)
                        .font(Theme.body(13, weight: .bold))
                        .lineLimit(1)
                    Text([row.addonName, kind].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(Theme.body(11))
                        .lineLimit(1)
                        .foregroundStyle(on ? Color.black.opacity(0.7) : Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(on ? Theme.logo : Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.logo : Theme.line, lineWidth: 1))
            .foregroundStyle(on ? Color.black : Theme.ink)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(cached ? "Cached. " : "")\(row.stream.headline)")
    }
}

struct EpisodeGrid: View {
    var count: Int
    var current: Int
    var seen: (Int) -> Bool
    var fraction: (Int) -> Double
    var marked: ((Int) -> Bool)? = nil
    var toggleMark: ((Int) -> Void)? = nil
    var filler: Set<Int> = []
    var select: (Int) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 8)], spacing: 8) {
            ForEach(1...max(count, 1), id: \.self) { number in
                ZStack(alignment: .topTrailing) {
                Button { select(number) } label: {
                    Text("\(number)")
                        .font(Theme.mono(13))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .foregroundStyle(number == current ? Theme.accent : (seen(number) ? Theme.muted : Theme.ink))
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(number == current ? Theme.accent : Theme.line, lineWidth: 1))
                        .overlay(alignment: .bottom) {
                            if fraction(number) > 0 {
                                GeometryReader { geo in
                                    Rectangle().fill(Theme.accent).frame(width: geo.size.width * fraction(number), height: 3)
                                        .frame(maxHeight: .infinity, alignment: .bottom)
                                }
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(alignment: .bottomLeading) {
                            if filler.contains(number) {
                                Text("Filler")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 3)
                                    .padding(.vertical, 1)
                                    .background(Color(red: 0.77, green: 0.23, blue: 0.23), in: RoundedRectangle(cornerRadius: 4))
                                    .padding(3)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(filler.contains(number) ? "Episode \(number), filler" : "Episode \(number)")
                if let toggleMark {
                    Button { toggleMark(number) } label: {
                        Image(systemName: (marked?(number) ?? false) ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle((marked?(number) ?? false) ? Theme.logo : Theme.muted)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .padding(2)
                    .accessibilityLabel((marked?(number) ?? false) ? "Mark episode \(number) unwatched" : "Mark episode \(number) watched")
                }
                }
            }
        }
    }
}

struct PrefToggle: View {
    var title: String
    var on: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(on ? Theme.logo : Theme.muted, lineWidth: 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(on ? Theme.logo : .clear))
                    .frame(width: 16, height: 16)
                    .overlay {
                        if on {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9, weight: .black))
                                .foregroundStyle(.black)
                        }
                    }
                Text(title).font(Theme.body(14)).foregroundStyle(on ? Theme.logo : Theme.muted)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct RouteScreen: View {
    var route: AppRoute

    var body: some View {
        switch route {
        case .anime(let id):
            AnimeDetailView(id: id)
        case .watch(let id, let episode, let auto):
            WatchView(anilistID: id, initialEpisode: episode, forceAuto: auto)
        case .meta(let addon, let type, let id):
            MetaDetailView(addonURL: addon, type: type, metaID: id)
        case .more(let list):
            MoreBrowseView(list: list)
        case .calendar:
            CalendarView()
        }
    }
}
