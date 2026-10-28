import Foundation

enum Tab: String, CaseIterable, Identifiable, Equatable {
    case search, home, watching, addons
    var id: String { rawValue }

    var title: String {
        switch self {
        case .search: return "Search"
        case .home: return "Home"
        case .watching: return "Watching"
        case .addons: return "Add-ons"
        }
    }
}

enum MoreList: Hashable {
    case continueWatching
    case trending
    case season
    case favourites
    case catalog(addon: String, type: String, id: String, title: String)
}

enum AppRoute: Hashable {
    case anime(Int)
    case watch(id: Int, episode: Int, auto: Bool)
    case meta(addon: String, type: String, id: String)
    case more(MoreList)

    /// Continue-watching rows open the episode. Catalog rows open the show.
    static func watching(_ route: String, episode: Int?) -> AppRoute? {
        if route.hasPrefix("a/"), let id = Int(route.dropFirst(2)), id > 0 {
            return .watch(id: id, episode: episode ?? 1, auto: false)
        }
        return stored(route)
    }

    static func stored(_ route: String) -> AppRoute? {
        if route.hasPrefix("a/"), let id = Int(route.dropFirst(2)), id > 0 {
            return .anime(id)
        }
        guard route.hasPrefix("m/") else { return nil }
        let parts = route.dropFirst(2).split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3 else { return nil }
        let id = parts[parts.count - 1]
        let type = parts[parts.count - 2]
        let addon = parts.dropLast(2).joined(separator: "|")
        guard !addon.isEmpty, !id.isEmpty else { return nil }
        return .meta(addon: addon, type: type, id: id)
    }
}

struct PlayerPrefs: Codable, Equatable {
    var autoPlay: Bool = true
    var autoNext: Bool = true
    var autoSkip: Bool = false
    var speed: Double = 1
    var subLang: String = ""
}

struct WatchItem: Codable, Equatable, Identifiable {
    var id: String { key }
    var key: String
    var title: String
    var poster: String?
    var added: Double
}

struct ContinueEntry: Identifiable {
    var id: String
    var item: ProgressItem
}

struct ProgressItem: Codable, Equatable {
    var t: Double
    var d: Double
    var updated: Double
    var route: String
    var title: String
    var poster: String?
    var label: String
    var episode: Int?
}

struct ShowIDs: Codable, Equatable {
    var anilist: Int
    var mal: Int?
    var kitsu: Int?
    var imdb: String?
    var imdbSeason: Int?
    var tmdb: Int?
}

struct AddonResource: Codable, Equatable {
    var name: String
    /// Nil means "inherit the manifest list". An empty array was sent on purpose.
    var types: [String]?
    var idPrefixes: [String]?
}

struct Catalog: Codable, Equatable, Identifiable {
    var id: String
    var type: String
    var name: String
    var requiresExtra: Bool
    var displayName: String { name.isEmpty ? id : name }
}

struct Manifest: Codable, Equatable {
    var id: String
    var name: String
    var version: String
    var description: String
    var logo: String?
    var resources: [AddonResource]
    var types: [String]
    var idPrefixes: [String]?
    var catalogs: [Catalog]
}

struct InstalledAddon: Codable, Equatable, Identifiable {
    var id: String { url }
    var url: String
    var manifest: Manifest
    var enabled: Bool
}

struct RepoEntry: Codable, Equatable, Identifiable {
    var id: String { url }
    var url: String
    var name: String
    var description: String
}

struct Repo: Codable, Equatable, Identifiable {
    var id: String { url }
    var url: String
    var name: String
    var entries: [RepoEntry]
}

struct Media: Equatable, Identifiable, Hashable {
    var id: Int
    var idMal: Int?
    var romaji: String?
    var english: String?
    var cover: String?
    var banner: String?
    var format: String?
    var status: String?
    var episodes: Int?
    var season: String?
    var seasonYear: Int?
    var averageScore: Int?
    var genres: [String]
    var synopsis: String?
    var nextEpisode: Int?
    var nextAiringAt: Int?
    var trailerYouTube: String?
    var studio: String?

    var title: String { english?.nilIfEmpty ?? romaji?.nilIfEmpty ?? "Untitled" }
    var isMovie: Bool { format == "MOVIE" }
    var ratingText: String? {
        guard let averageScore, averageScore > 0 else { return nil }
        return String(format: "%.1f", Double(averageScore) / 10)
    }

    var episodeCount: Int {
        if isMovie { return 1 }
        let aired = nextEpisode.map { $0 - 1 } ?? episodes
        let n = max(aired ?? 0, 0)
        return n == 0 ? 12 : n
    }
}

struct SubtitleLink: Hashable {
    var url: String
    var lang: String
}

struct Stream: Hashable {
    var name: String?
    var title: String?
    var description: String?
    var url: String?
    var externalUrl: String?
    var ytId: String?
    var infoHash: String?
    var filename: String?
    var bingeGroup: String?
    var subtitles: [SubtitleLink]

    var playableURL: Bool { url?.isEmpty == false }
    var headline: String {
        let raw = (name?.nilIfEmpty ?? title?.nilIfEmpty ?? "Source")
        return raw.split(whereSeparator: \.isNewline).first.map(String.init) ?? raw
    }
}

enum AudioKind: String, Hashable {
    case sub, dub, other
}

struct StreamRow: Identifiable, Hashable {
    var id: Int { index }
    var index: Int
    var addonName: String
    var addonURL: String
    var stream: Stream
    var audio: AudioKind
}

struct AddonReport: Identifiable, Hashable {
    var id: String { name + why }
    var name: String
    var why: String
}

struct MetaPreview: Identifiable, Hashable {
    var id: String
    var type: String
    var name: String
    var poster: String?
    var background: String?
    var description: String?
    var releaseInfo: String?
    var imdbRating: String?
    var genres: [String]
    var videos: [MetaVideo]
}

struct MetaVideo: Identifiable, Hashable {
    var id: String
    var title: String
    var season: Int?
    var episode: Int?
    var thumbnail: String?
}

struct AiringNote: Identifiable, Hashable {
    var id: String
    var mediaID: Int
    var title: String
    var poster: String?
    var episode: Int
    var when: String
    var fresh: Bool
}

struct NotesState: Equatable {
    var aired: [AiringNote] = []
    var upcoming: [AiringNote] = []
    var error = false
}

struct PlaybackFailure: Equatable, Error {
    enum Kind: String {
        case slate, realDebrid, statusClip, http, player, other
    }
    var kind: Kind
    var message: String
}

struct PlayRequest: Equatable {
    var token: UUID
    var url: URL
    var resume: Double?
    var subtitles: [URL]
    var treatShortAsError: Bool
    var label: String
}

struct WatchContext: Equatable {
    var key: String
    var route: String
    var title: String
    var poster: String?
    var label: String
    var shortLabel: String
    var episode: Int?
    var subIDs: [String]
    var subType: String
    var hasNext: Bool
    var nextLabel: String?
}

enum AddonError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum JSONValue {
    static func dict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }
    static func array(_ any: Any?) -> [Any]? { any as? [Any] }

    static func string(_ any: Any?) -> String? {
        switch any {
        case let s as String: return s
        case let i as Int: return String(i)
        case let d as Double:
            if d.rounded() == d { return String(Int(d)) }
            return String(d)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            return n.stringValue
        default: return nil
        }
    }

    static func int(_ any: Any?) -> Int? {
        switch any {
        case let i as Int: return i
        case let d as Double: return Int(d)
        case let s as String: return Int(s.trimmingCharacters(in: .whitespaces))
        case let n as NSNumber: return n.intValue
        default: return nil
        }
    }

    static func strings(_ any: Any?) -> [String] {
        (any as? [Any])?.compactMap { string($0) } ?? []
    }
}
