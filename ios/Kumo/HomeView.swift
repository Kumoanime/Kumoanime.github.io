import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var trending: [Media]?
    @State private var seasonTitle = ""
    @State private var season: [Media]?
    @State private var favourites: [Media]?
    @State private var failed = false
    @State private var showNotes = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if !model.continueItems().isEmpty {
                    section("Continue watching", more: .more(.continueWatching)) {
                        Rail {
                            ForEach(model.continueItems(), id: \.route) { item in
                                if let route = AppRoute.watching(item.route, episode: item.episode) {
                                    NavigationLink(value: route) {
                                        PosterCard(title: item.title, poster: item.poster, subtitle: item.label, progress: item.d > 0 ? item.t / item.d : nil)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            NavigationLink(value: AppRoute.more(.continueWatching)) { MoreTile() }
                                .buttonStyle(.plain)
                        }
                    }
                }
                rail("Trending now", items: trending, more: .more(.trending))
                rail(seasonTitle.isEmpty ? "This season" : seasonTitle, items: season, more: .more(.season))
                rail("All-time favourites", items: favourites, more: .more(.favourites))
                ForEach(Array(model.catalogSources.enumerated()), id: \.offset) { _, pair in
                    CatalogRail(addon: pair.0, catalog: pair.1)
                }
                if model.addons.isEmpty {
                    section("Get more from Kumo") {
                        EmptyBlock(title: "Add your first add-on", message: "Add-ons supply the episodes Kumo can play. Open Add-ons and paste a manifest link.")
                    }
                }
                if failed {
                    Text("Couldn't reach AniList for show info. Check your connection and reload.")
                        .font(Theme.body(13))
                        .foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) { KumoWordmark() }
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 8) {
                    NavigationLink(value: AppRoute.calendar) {
                        Image(systemName: "calendar")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(width: 38, height: 38)
                            .background(Theme.surface, in: Circle())
                            .overlay(Circle().stroke(Theme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Airing calendar")
                    bell
                }
            }
        }
        .sheet(isPresented: $showNotes) {
            NotesSheet().environmentObject(model)
        }
        .task { await load() }
        .refreshable { await load(force: true) }
    }

    private var bell: some View {
        Button {
            showNotes = true
            model.markNotesSeen()
        } label: {
            Image(systemName: "bell.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 38, height: 38)
                .background(Theme.surface, in: Circle())
                .overlay(Circle().stroke(Theme.line, lineWidth: 1))
                .overlay(alignment: .topTrailing) {
                    if model.unreadNotes > 0 {
                        Text(model.unreadNotes > 9 ? "9+" : "\(model.unreadNotes)")
                            .font(Theme.mono(10))
                            .foregroundStyle(Theme.accentInk)
                            .padding(.horizontal, 5)
                            .frame(height: 18)
                            .background(Theme.accent, in: Capsule())
                            .offset(x: 6, y: -4)
                    }
                }
        }
        .accessibilityLabel(model.unreadNotes > 0 ? "\(model.unreadNotes) new episodes" : "New episodes")
    }

    @ViewBuilder private func rail(_ title: String, items: [Media]?, more: AppRoute) -> some View {
        section(title, more: more) {
            if let items {
                Rail {
                    ForEach(items) { media in
                        NavigationLink(value: AppRoute.anime(media.id)) {
                            PosterCard(
                                title: media.title,
                                poster: media.cover,
                                subtitle: [media.seasonYear.map(String.init), media.format?.replacingOccurrences(of: "_", with: " ")].compactMap { $0 }.joined(separator: " · "),
                                rating: media.ratingText
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    NavigationLink(value: more) { MoreTile() }
                        .buttonStyle(.plain)
                }
            } else {
                SkeletonRail()
            }
        }
    }

    private func section<Content: View>(_ title: String, more: AppRoute? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: title, more: more)
            content()
        }
    }

    private func load(force: Bool = false) async {
        if force { model.clearListCache() }
        do {
            trending = try await model.trending()
            let seasonResult = try await model.seasonRail()
            seasonTitle = seasonResult.0
            season = seasonResult.1
            favourites = try await model.favourites()
            failed = false
        } catch {
            failed = trending == nil
        }
        await model.loadNotes()
    }
}

private struct CatalogRail: View {
    @EnvironmentObject private var model: AppModel
    var addon: InstalledAddon
    var catalog: Catalog
    @State private var metas: [MetaPreview]?
    @State private var failed = false

    private var moreRoute: AppRoute {
        .more(.catalog(addon: addon.url, type: catalog.type, id: catalog.id, title: catalog.displayName))
    }

    var body: some View {
        Group {
            if let metas, metas.isEmpty, !failed {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHead(title: catalog.displayName, note: addon.manifest.name, more: moreRoute)
                    if let metas {
                        Rail {
                            ForEach(Array(metas.prefix(30).enumerated()), id: \.offset) { _, meta in
                                NavigationLink(value: AppRoute.meta(addon: addon.url, type: meta.type.isEmpty ? catalog.type : meta.type, id: meta.id)) {
                                    PosterCard(title: meta.name, poster: meta.poster, subtitle: meta.releaseInfo, rating: meta.imdbRating)
                                }
                                .buttonStyle(.plain)
                            }
                            NavigationLink(value: moreRoute) { MoreTile() }
                                .buttonStyle(.plain)
                        }
                    } else if failed {
                        Text("\(addon.manifest.name) didn't respond.")
                            .font(Theme.body(13))
                            .foregroundStyle(Theme.muted)
                    } else {
                        SkeletonRail()
                    }
                }
            }
        }
        .task {
            if let loaded = await model.loadCatalog(addon, catalog) {
                metas = loaded
            } else {
                failed = true
                metas = []
            }
        }
    }
}

struct NotesSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("NEW EPISODES").font(Theme.mono(11)).foregroundStyle(Theme.muted).padding(.top, 8)
                    if model.watchlist.isEmpty {
                        Text("Add shows to Watching and new episodes will show up here.")
                            .font(Theme.body(13)).foregroundStyle(Theme.muted)
                    } else if model.notes.error {
                        Text("Couldn't check for new episodes. Try again in a bit.")
                            .font(Theme.body(13)).foregroundStyle(Theme.muted)
                    } else if model.notes.aired.isEmpty {
                        Text("No new episodes in the last two weeks.")
                            .font(Theme.body(13)).foregroundStyle(Theme.muted)
                    } else {
                        ForEach(model.notes.aired) { note in
                            noteButton(note)
                        }
                    }
                    if !model.notes.upcoming.isEmpty {
                        Text("COMING UP").font(Theme.mono(11)).foregroundStyle(Theme.muted).padding(.top, 12)
                        ForEach(model.notes.upcoming) { note in
                            noteButton(note)
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle("New episodes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func noteButton(_ note: AiringNote) -> some View {
        Button {
            model.pendingRoute = .anime(note.mediaID)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                PosterImage(url: note.poster).frame(width: 36, height: 54).clipShape(RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.title).font(Theme.body(14, weight: .bold)).lineLimit(1)
                    Text("Episode \(note.episode) · \(note.when)").font(Theme.body(12)).foregroundStyle(Theme.muted)
                }
                Spacer()
            }
            .padding(8)
        }
        .buttonStyle(.plain)
    }
}
