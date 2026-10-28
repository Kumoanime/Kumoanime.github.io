import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var addons: [InstalledAddon] = []
    @Published var repos: [Repo] = []
    @Published var watchlist: [String: WatchItem] = [:]
    @Published var progress: [String: ProgressItem] = [:]
    @Published var prefs = PlayerPrefs()
    @Published var toast: String?
    @Published var notes = NotesState()
    @Published var unreadNotes = 0
    @Published var hasPastedToken = false
    @Published var requestedTab: Tab?
    @Published var pendingRoute: AppRoute?

    private var ids: [String: ShowIDs] = [:]
    private var removed: [String: Double] = [:]
    private var notesSeen: Double = 0
    private var mediaCache: [Int: Media] = [:]
    private var listCache: [String: [Media]] = [:]
    private var toastTask: Task<Void, Never>?
    private let anilist = AniListClient()
    private let client = AddonClient()

    static let pastedTokenAccount = "rd.token"
    static let extractedTokenAccount = "rd.token.extracted"

    init() {
        addons = Store.get("addons", as: [InstalledAddon].self, default: [])
        repos = Store.get("repos", as: [Repo].self, default: [])
        watchlist = Store.get("watchlist", as: [String: WatchItem].self, default: [:])
        progress = Store.get("progress", as: [String: ProgressItem].self, default: [:])
        prefs = Store.get("prefs", as: PlayerPrefs.self, default: PlayerPrefs())
        ids = Store.get("ids", as: [String: ShowIDs].self, default: [:])
        removed = Store.get("removed", as: [String: Double].self, default: [:])
        notesSeen = Store.double("notesSeen")
        hasPastedToken = KeychainStore.get(Self.pastedTokenAccount) != nil
        rememberExtractedToken()
    }

    func showToast(_ message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            if !Task.isCancelled { toast = nil }
        }
    }

    func route(for id: Int) -> String { "a/\(id)" }

    func progressKey(route: String, episode: Int) -> String { "\(route):\(episode)" }

    func fraction(route: String, episode: Int) -> Double {
        guard let item = progress[progressKey(route: route, episode: episode)], item.d > 0 else { return 0 }
        return min(1, item.t / item.d)
    }

    func nextEpisode(route: String, count: Int) -> Int {
        var last = 0
        for (key, item) in progress where key.hasPrefix(route + ":") {
            let n = Int(key.split(separator: ":").last.map(String.init) ?? "") ?? 0
            if item.d > 0 && item.t / item.d > 0.92 { last = max(last, n) }
            else if item.t > 0 { last = max(last, n - 1) }
        }
        return min(max(last + 1, 1), max(count, 1))
    }

    func resumeTime(route: String, episode: Int) -> Double? {
        guard let item = progress[progressKey(route: route, episode: episode)], item.d > 0, item.t > 5, item.t / item.d < 0.92 else { return nil }
        return item.t
    }

    func saveProgress(key: String, time: Double, duration: Double, route: String, title: String, poster: String?, label: String, episode: Int?) {
        guard duration > 1, time >= 0 else { return }
        progress[key] = ProgressItem(t: time, d: duration, updated: Date().timeIntervalSince1970, route: route, title: title, poster: poster, label: label, episode: episode)
        Store.set("progress", progress)
    }

    func continueItems() -> [ProgressItem] {
        var byShow: [String: ProgressItem] = [:]
        for item in progress.values {
            if item.route.isEmpty { continue }
            if item.d > 0 && item.t / item.d > 0.92 { continue }
            if let existing = byShow[item.route], existing.updated >= item.updated { continue }
            byShow[item.route] = item
        }
        return byShow.values.sorted { $0.updated > $1.updated }.prefix(15).map { $0 }
    }

    func continueAll() -> [ContinueEntry] {
        progress.compactMap { key, item in
            guard !item.route.isEmpty else { return nil }
            if item.d > 0 && item.t / item.d > 0.92 { return nil }
            return ContinueEntry(id: key, item: item)
        }
        .sorted { $0.item.updated > $1.item.updated }
    }

    func watchingItems() -> [WatchItem] {
        watchlist.values.sorted { $0.added > $1.added }
    }

    func toggleWatch(key: String, title: String, poster: String?) {
        if watchlist[key] != nil {
            watchlist.removeValue(forKey: key)
            removed[key] = Date().timeIntervalSince1970
            Store.set("removed", removed)
            showToast("Removed from Watching")
        } else {
            watchlist[key] = WatchItem(key: key, title: title, poster: poster, added: Date().timeIntervalSince1970)
            showToast("Added to Watching")
        }
        Store.set("watchlist", watchlist)
        Task { await loadNotes() }
    }

    func setPref(_ update: (inout PlayerPrefs) -> Void) {
        update(&prefs)
        Store.set("prefs", prefs)
    }

    // MARK: token

    func effectiveToken() -> String? {
        if let pasted = KeychainStore.get(Self.pastedTokenAccount), pasted.count > 8 { return pasted }
        if let extracted = KeychainStore.get(Self.extractedTokenAccount), extracted.count > 8 { return extracted }
        return StreamLogic.tokenFromAddons(addons)?.token
    }

    func tokenDescription() -> String {
        if hasPastedToken {
            return "Using the Real-Debrid token saved in this iPhone's Keychain."
        }
        if let found = StreamLogic.tokenFromAddons(addons) {
            return "Using the Real-Debrid key already in your \(found.from) add-on. A copy is kept in the Keychain."
        }
        return "No Real-Debrid token yet. Paste one, or install Comet from a link that still has your key in it."
    }

    func savePastedToken(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            hasPastedToken = KeychainStore.get(Self.pastedTokenAccount) != nil
        } else {
            KeychainStore.set(trimmed, account: Self.pastedTokenAccount)
            hasPastedToken = true
        }
        showToast("Real-Debrid token saved")
    }

    func clearPastedToken() {
        KeychainStore.delete(Self.pastedTokenAccount)
        hasPastedToken = false
        showToast("Forgot the pasted token")
    }

    private func rememberExtractedToken() {
        guard let found = StreamLogic.tokenFromAddons(addons) else { return }
        KeychainStore.set(found.token, account: Self.extractedTokenAccount)
    }

    // MARK: add-ons

    func installAddon(_ raw: String) async {
        do {
            let (url, manifest) = try await client.manifest(from: raw)
            if addons.contains(where: { AddonURLs.addonKey($0.url) == AddonURLs.addonKey(url) }) {
                showToast("That add-on is already installed")
                return
            }
            addons.append(InstalledAddon(url: url, manifest: manifest, enabled: true))
            Store.set("addons", addons)
            rememberExtractedToken()
            showToast("Installed \(manifest.name)")
        } catch {
            showToast(errorText(error))
        }
    }

    func addRepo(_ raw: String) async {
        do {
            let repo = try await client.repository(from: raw)
            repos.removeAll { $0.url == repo.url }
            repos.append(repo)
            Store.set("repos", repos)
            showToast("Added \(repo.entries.count) add-on\(repo.entries.count == 1 ? "" : "s") to browse")
        } catch {
            showToast(errorText(error))
        }
    }

    func setAddon(_ url: String, enabled: Bool) {
        guard let index = addons.firstIndex(where: { $0.url == url }) else { return }
        addons[index].enabled = enabled
        Store.set("addons", addons)
        rememberExtractedToken()
    }

    func removeAddon(_ url: String) {
        addons.removeAll { $0.url == url }
        Store.set("addons", addons)
        rememberExtractedToken()
        showToast("Add-on removed")
    }

    func removeRepo(_ url: String) {
        repos.removeAll { $0.url == url }
        Store.set("repos", repos)
    }

    var catalogSources: [(InstalledAddon, Catalog)] {
        addons.filter(\.enabled).flatMap { addon in
            addon.manifest.catalogs.filter { !$0.requiresExtra }.prefix(3).map { (addon, $0) }
        }
    }

    func loadCatalog(_ addon: InstalledAddon, _ catalog: Catalog) async -> [MetaPreview]? {
        try? await client.catalog(addon, catalog)
    }

    func browse(_ list: MoreList, page: Int) async throws -> (items: [Media], more: Bool) {
        switch list {
        case .trending:
            return try await anilist.browse(page: page, sort: ["TRENDING_DESC"], status: "RELEASING")
        case .season:
            let season = currentSeason()
            return try await anilist.browse(page: page, sort: ["POPULARITY_DESC"], season: season.season, year: season.year)
        case .favourites:
            return try await anilist.browse(page: page, sort: ["SCORE_DESC"], status: "FINISHED")
        case .continueWatching, .catalog:
            return ([], false)
        }
    }

    func browseCatalog(addonURL: String, type: String, id: String, skip: Int) async throws -> [MetaPreview] {
        guard let addon = addons.first(where: { $0.url == addonURL }) else {
            throw AddonError.message("That add-on isn't installed")
        }
        guard let catalog = addon.manifest.catalogs.first(where: { $0.type == type && $0.id == id }) else {
            throw AddonError.message("That catalogue isn't on this add-on")
        }
        return try await client.catalog(addon, catalog, skip: skip)
    }

    func loadMeta(addonURL: String, type: String, id: String) async -> MetaPreview? {
        guard let addon = addons.first(where: { $0.url == addonURL }) else { return nil }
        return try? await client.meta(addon, type: type, id: id)
    }

    // MARK: anilist

    func trending() async throws -> [Media] {
        try await cachedList("trending") {
            try await anilist.list(sort: ["TRENDING_DESC"], status: "RELEASING")
        }
    }

    func seasonRail() async throws -> (String, [Media]) {
        let season = currentSeason()
        let items = try await cachedList("season-\(season.season)-\(season.year)") {
            try await anilist.list(sort: ["POPULARITY_DESC"], season: season.season, year: season.year)
        }
        return (season.label, items)
    }

    func favourites() async throws -> [Media] {
        try await cachedList("top") {
            try await anilist.list(sort: ["SCORE_DESC"], status: "FINISHED")
        }
    }

    func media(id: Int) async throws -> Media {
        if let cached = mediaCache[id] { return cached }
        let item = try await anilist.media(id: id)
        mediaCache[id] = item
        return item
    }

    func search(page: Int, filters: SearchFilters) async throws -> (items: [Media], more: Bool) {
        let hidden = watchlist.keys.compactMap { key -> Int? in
            guard key.hasPrefix("a/") else { return nil }
            return Int(key.dropFirst(2))
        }
        return try await anilist.search(page: page, filters: filters, hiddenIDs: hidden)
    }

    func showIDs(for media: Media) async -> ShowIDs {
        let key = String(media.id)
        if let cached = ids[key] { return cached }
        let fetched = await anilist.showIDs(for: media)
        if fetched.kitsu != nil || fetched.imdb != nil {
            ids[key] = fetched
            Store.set("ids", ids)
        }
        return fetched
    }

    func fetchStreams(media: Media, episode: Int) async -> (rows: [StreamRow], reports: [AddonReport], context: WatchContext) {
        let ids = await showIDs(for: media)
        let movie = media.isMovie
        var candidates: [(id: String, anime: Bool)] = []
        if let kitsu = ids.kitsu {
            candidates.append((movie ? "kitsu:\(kitsu)" : "kitsu:\(kitsu):\(episode)", true))
        }
        if let imdb = ids.imdb {
            let season = ids.imdbSeason ?? 1
            candidates.append((movie ? imdb : "\(imdb):\(season):\(episode)", false))
        }
        if let mal = ids.mal {
            candidates.append((movie ? "mal:\(mal)" : "mal:\(mal):\(episode)", true))
        }
        if let tmdb = ids.tmdb {
            let season = ids.imdbSeason ?? 1
            candidates.append((movie ? "tmdb:\(tmdb)" : "tmdb:\(tmdb):\(season):\(episode)", false))
        }
        candidates.append(("anilist:\(media.id):\(episode)", true))

        let enabled = addons.filter(\.enabled)
        var reports: [AddonReport] = []
        var collected: [(InstalledAddon, [Stream])] = []

        await withTaskGroup(of: (InstalledAddon, [Stream], String?).self) { group in
            for addon in enabled {
                group.addTask {
                    await self.streams(from: addon, media: media, movie: movie, candidates: candidates)
                }
            }
            for await result in group {
                if let why = result.2 {
                    reports.append(AddonReport(name: result.0.manifest.name, why: why))
                }
                if !result.1.isEmpty {
                    collected.append((result.0, result.1))
                }
            }
        }

        var rows: [StreamRow] = []
        var index = 0
        for (addon, streams) in collected {
            for stream in streams {
                rows.append(StreamRow(index: index, addonName: addon.manifest.name, addonURL: addon.url, stream: stream, audio: StreamLogic.audio(of: stream)))
                index += 1
            }
        }

        let route = route(for: media.id)
        let count = media.episodeCount
        let short = movie ? "Movie" : "Episode \(episode)"
        let context = WatchContext(
            key: progressKey(route: route, episode: episode),
            route: route,
            title: media.title,
            poster: media.cover,
            label: "\(media.title) · \(short)",
            shortLabel: short,
            episode: episode,
            subIDs: candidates.map(\.id),
            subType: movie ? "movie" : "series",
            hasNext: !movie && episode < count,
            nextLabel: !movie && episode < count ? "Episode \(episode + 1)" : nil
        )
        return (rows, reports, context)
    }

    func fetchMetaStreams(addonURL: String, meta: MetaPreview, video: MetaVideo?) async -> (rows: [StreamRow], context: WatchContext) {
        let id = video?.id ?? meta.id
        let type = meta.type.isEmpty ? "series" : meta.type
        var rows: [StreamRow] = []
        var index = 0
        await withTaskGroup(of: (InstalledAddon, [Stream]).self) { group in
            for addon in addons where addon.enabled && addon.manifest.handles("stream", id: id) {
                group.addTask {
                    let streams = (try? await self.client.streams(addon, type: type, id: id)) ?? []
                    return (addon, streams)
                }
            }
            for await (addon, streams) in group {
                for stream in streams {
                    rows.append(StreamRow(index: index, addonName: addon.manifest.name, addonURL: addon.url, stream: stream, audio: StreamLogic.audio(of: stream)))
                    index += 1
                }
            }
        }
        let label = video.map { $0.title } ?? meta.name
        let route = "m/\(addonURL)|\(type)|\(meta.id)"
        let context = WatchContext(
            key: "\(route):\(id)",
            route: route,
            title: meta.name,
            poster: meta.poster,
            label: label == meta.name ? meta.name : "\(meta.name) · \(label)",
            shortLabel: label,
            episode: video?.episode,
            subIDs: [id],
            subType: type,
            hasNext: false,
            nextLabel: nil
        )
        return (rows, context)
    }

    func subtitleURLs(ids: [String], type: String, stream: Stream) async -> [URL] {
        var links = stream.subtitles
        await withTaskGroup(of: [SubtitleLink].self) { group in
            for addon in addons where addon.enabled && addon.manifest.spec("subtitles") != nil {
                guard let id = ids.first(where: { addon.manifest.handles("subtitles", id: $0) }) else { continue }
                group.addTask { await self.client.subtitles(addon, type: type, id: id) }
            }
            for await found in group { links.append(contentsOf: found) }
        }
        var seen = Set<String>()
        return links.compactMap { link in
            guard seen.insert(link.url).inserted, let url = URL(string: link.url) else { return nil }
            return url
        }
    }

    private func streams(from addon: InstalledAddon, media: Media, movie: Bool, candidates: [(id: String, anime: Bool)]) async -> (InstalledAddon, [Stream], String?) {
        guard let spec = addon.manifest.spec("stream") else {
            return (addon, [], "doesn't provide episodes")
        }
        let usable = candidates.filter { addon.manifest.handles("stream", id: $0.id) }.prefix(3)
        if usable.isEmpty {
            let prefixes = spec.prefixes?.joined(separator: ", ")
            return (addon, [], "only accepts \(prefixes?.nilIfEmpty ?? "unknown") ids, which Kumo couldn't find for this show")
        }
        var tried: [String] = []
        for candidate in usable {
            let type = movie ? "movie" : (candidate.anime && spec.types.contains("anime") ? "anime" : "series")
            let format = candidate.id.split(separator: ":").first.map(String.init)?.replacingOccurrences(of: #"^tt\d+$"#, with: "imdb", options: .regularExpression) ?? candidate.id
            if !spec.types.isEmpty && !spec.types.contains(type) {
                tried.append("\(format): skipped, add-on doesn't take \(type)")
                continue
            }
            do {
                let found = try await client.streams(addon, type: type, id: candidate.id)
                if !found.isEmpty {
                    if !found.contains(where: { $0.url?.isEmpty == false || $0.ytId?.isEmpty == false || $0.externalUrl?.isEmpty == false }) {
                        return (addon, found, "only has torrent sources")
                    }
                    return (addon, found, nil)
                }
                tried.append("\(format): no results")
            } catch let error as AddonError {
                if case .message(let text) = error, text.hasPrefix("HTTP") {
                    tried.append("\(format): error \(text)")
                    continue
                }
                return (addon, [], "didn't respond. It may be offline, or it blocks this network")
            } catch {
                return (addon, [], "didn't respond. It may be offline, or it blocks this network")
            }
        }
        return (addon, [], "had nothing for this episode (tried \(tried.joined(separator: ", ")))")
    }

    func loadNotes() async {
        let ids = watchlist.keys.compactMap { key -> Int? in
            guard key.hasPrefix("a/") else { return nil }
            return Int(key.dropFirst(2))
        }
        guard !ids.isEmpty else {
            notes = NotesState()
            unreadNotes = 0
            return
        }
        do {
            let result = try await anilist.notes(ids: ids)
            let aired: [AiringNote] = result.aired.compactMap { item in
                guard let media = item["media"] as? [String: Any] else { return nil }
                let parsed = Media.parse(media)
                guard let episode = JSONValue.int(item["episode"]) else { return nil }
                let at = JSONValue.int(item["airingAt"]) ?? 0
                return AiringNote(
                    id: "aired-\(parsed.id)-\(episode)",
                    mediaID: parsed.id,
                    title: parsed.title,
                    poster: parsed.cover,
                    episode: episode,
                    when: ago(at),
                    fresh: Double(at) * 1000 > notesSeen
                )
            }
            let upcoming: [AiringNote] = result.upcoming.compactMap { item in
                let parsed = Media.parse(item)
                guard let episode = parsed.nextEpisode, let at = parsed.nextAiringAt else { return nil }
                let date = Date(timeIntervalSince1970: TimeInterval(at))
                let text = date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
                return AiringNote(id: "next-\(parsed.id)", mediaID: parsed.id, title: parsed.title, poster: parsed.cover, episode: episode, when: text, fresh: false)
            }.sorted { $0.when < $1.when }
            notes = NotesState(aired: aired, upcoming: upcoming, error: false)
            unreadNotes = aired.filter(\.fresh).count
        } catch {
            notes.error = true
        }
    }

    func markNotesSeen() {
        notesSeen = Date().timeIntervalSince1970 * 1000
        Store.setDouble("notesSeen", notesSeen)
        unreadNotes = 0
        notes.aired = notes.aired.map { var note = $0; note.fresh = false; return note }
    }

    func clearListCache() {
        listCache.removeAll()
    }

    private func cachedList(_ key: String, _ load: () async throws -> [Media]) async throws -> [Media] {
        if let cached = listCache[key] { return cached }
        let items = try await load()
        listCache[key] = items
        return items
    }

    private func ago(_ unix: Int) -> String {
        let minutes = Int(Date().timeIntervalSince1970 - Double(unix)) / 60
        if minutes < 60 { return "\(max(minutes, 1)) min ago" }
        if minutes < 1440 { return "\(minutes / 60) h ago" }
        return "\(minutes / 1440) d ago"
    }

    private func errorText(_ error: Error) -> String {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if text.lowercased().contains("hostname") || text.lowercased().contains("offline") || text.lowercased().contains("network") || text.lowercased().contains("timed out") {
            return "Couldn't reach that link. Check it's https and online."
        }
        return text
    }
}
