import Foundation

struct AniListClient {
    private let endpoint = URL(string: "https://graphql.anilist.co")!

    func list(sort: [String], season: String? = nil, year: Int? = nil, status: String? = nil, search: String? = nil) async throws -> [Media] {
        let query = """
        query($sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus,$search:String){
          Page(perPage:30){ media(type:ANIME,isAdult:false,sort:$sort,season:$season,seasonYear:$year,status:$status,search:$search){ \(Self.fields) } }
        }
        """
        var variables: [String: Any] = ["sort": sort]
        if let season { variables["season"] = season }
        if let year { variables["year"] = year }
        if let status { variables["status"] = status }
        if let search { variables["search"] = search }
        let data = try await graph(query, variables)
        let media = ((data["Page"] as? [String: Any])?["media"] as? [Any]) ?? []
        return media.compactMap { ($0 as? [String: Any]).map(Media.parse) }
    }

    func browse(page: Int, sort: [String], season: String? = nil, year: Int? = nil, status: String? = nil) async throws -> (items: [Media], more: Bool) {
        let query = """
        query($page:Int,$sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus){
          Page(page:$page,perPage:50){
            pageInfo{ hasNextPage }
            media(type:ANIME,isAdult:false,sort:$sort,season:$season,seasonYear:$year,status:$status){ \(Self.fields) }
          }
        }
        """
        var variables: [String: Any] = ["page": page, "sort": sort]
        if let season { variables["season"] = season }
        if let year { variables["year"] = year }
        if let status { variables["status"] = status }
        let data = try await graph(query, variables)
        let pageObj = data["Page"] as? [String: Any]
        let media = (pageObj?["media"] as? [Any]) ?? []
        let more = ((pageObj?["pageInfo"] as? [String: Any])?["hasNextPage"] as? Bool) ?? false
        return (media.compactMap { ($0 as? [String: Any]).map(Media.parse) }, more)
    }

    func search(page: Int, filters: SearchFilters, hiddenIDs: [Int]) async throws -> (items: [Media], more: Bool) {
        let query = """
        query($page:Int,$search:String,$genre:[String],$season:MediaSeason,$year:Int,$format:[MediaFormat],$status:MediaStatus,$country:CountryCode,$score:Int,$source:MediaSource,$epsMin:Int,$epsMax:Int,$notIn:[Int],$sort:[MediaSort]){
          Page(page:$page,perPage:30){
            pageInfo{ hasNextPage }
            media(type:ANIME,isAdult:false,search:$search,genre_in:$genre,season:$season,seasonYear:$year,format_in:$format,status:$status,countryOfOrigin:$country,averageScore_greater:$score,source:$source,episodes_greater:$epsMin,episodes_lesser:$epsMax,id_not_in:$notIn,sort:$sort){ \(Self.fields) }
          }
        }
        """
        var variables: [String: Any] = ["page": page]
        if let q = filters.q.nilIfEmpty { variables["search"] = q }
        if let genre = filters.genre { variables["genre"] = [genre] }
        if let season = filters.season { variables["season"] = season }
        if let year = filters.year, let n = Int(year) { variables["year"] = n }
        if let format = filters.format { variables["format"] = [format] }
        if let status = filters.status { variables["status"] = status }
        if let country = filters.country { variables["country"] = country }
        if let rating = filters.rating, let n = Int(rating) { variables["score"] = n - 1 }
        if let source = filters.source { variables["source"] = source }
        if let episodes = filters.episodes {
            let parts = episodes.split(separator: "-").map(String.init)
            if let a = parts.first, let n = Int(a) { variables["epsMin"] = n - 1 }
            if parts.count > 1, let b = Int(parts[1]) { variables["epsMax"] = b + 1 }
        }
        if filters.excludeWatching && !hiddenIDs.isEmpty { variables["notIn"] = hiddenIDs }
        let sort = filters.sort ?? (filters.q.nilIfEmpty == nil ? "POPULARITY_DESC" : "SEARCH_MATCH")
        variables["sort"] = [sort]
        let data = try await graph(query, variables)
        let pageObj = data["Page"] as? [String: Any]
        let media = (pageObj?["media"] as? [Any]) ?? []
        let more = ((pageObj?["pageInfo"] as? [String: Any])?["hasNextPage"] as? Bool) ?? false
        return (media.compactMap { ($0 as? [String: Any]).map(Media.parse) }, more)
    }

    func media(id: Int) async throws -> Media {
        let query = """
        query($id:Int){ Media(id:$id,type:ANIME){ \(Self.fields) description(asHtml:false) studios(isMain:true){ nodes { name } } } }
        """
        let data = try await graph(query, ["id": id])
        guard let obj = data["Media"] as? [String: Any] else {
            throw AddonError.message("Couldn't load this show")
        }
        return Media.parse(obj)
    }

    func showIDs(for media: Media) async -> ShowIDs {
        var ids = ShowIDs(anilist: media.id, mal: media.idMal, kitsu: nil, imdb: nil, imdbSeason: nil, tmdb: nil)
        if let url = URL(string: "https://arm.haglund.dev/api/v2/ids?source=anilist&id=\(media.id)"),
           let (data, http) = try? await Net.data(from: url),
           (200..<300).contains(http.statusCode),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            ids.kitsu = JSONValue.int(obj["kitsu"])
            ids.imdb = JSONValue.string(obj["imdb"])
            ids.imdbSeason = JSONValue.int(obj["thetvdb-season"]) ?? JSONValue.int(obj["themoviedb-season"])
            ids.tmdb = JSONValue.int(obj["themoviedb"])
            ids.mal = JSONValue.int(obj["myanimelist"]) ?? media.idMal
        }
        if ids.kitsu == nil, let mal = media.idMal {
            for host in ["https://kitsu.app", "https://kitsu.io"] {
                guard let url = URL(string: "\(host)/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=\(mal)&include=item") else { continue }
                if let (data, http) = try? await Net.data(from: url, headers: ["Accept": "application/vnd.api+json"]),
                   (200..<300).contains(http.statusCode),
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let first = (obj["data"] as? [Any])?.first as? [String: Any],
                   let rel = first["relationships"] as? [String: Any],
                   let item = rel["item"] as? [String: Any],
                   let itemData = item["data"] as? [String: Any],
                   let id = JSONValue.int(itemData["id"]) ?? Int(JSONValue.string(itemData["id"]) ?? "") {
                    ids.kitsu = id
                    break
                }
            }
        }
        return ids
    }

    func recommendations(id: Int) async throws -> [Media] {
        let query = """
        query($id:Int){ Media(id:$id,type:ANIME){ recommendations(sort:RATING_DESC,perPage:20){ nodes{ mediaRecommendation{ \(Self.fields) } } } } }
        """
        let data = try await graph(query, ["id": id])
        let nodes = (((data["Media"] as? [String: Any])?["recommendations"] as? [String: Any])?["nodes"] as? [Any]) ?? []
        return nodes.compactMap { node in
            let media = (node as? [String: Any])?["mediaRecommendation"] as? [String: Any]
            return media.map(Media.parse)
        }.filter { $0.id > 0 }
    }

    func airingWeek(from: Int, to: Int, mediaIDs: [Int]?) async throws -> [AiringSlot] {
        guard mediaIDs?.isEmpty != true || mediaIDs == nil else { return [] }
        let chunks: [[Int]?]
        if let mediaIDs {
            chunks = stride(from: 0, to: mediaIDs.count, by: 40).map { Array(mediaIDs[$0..<min($0 + 40, mediaIDs.count)]) }
        } else {
            chunks = [nil]
        }
        var rows: [AiringSlot] = []
        for chunk in chunks {
            for page in 1...6 {
                let query: String
                var variables: [String: Any] = ["page": page, "from": from, "to": to]
                if let chunk {
                    query = """
                    query($page:Int,$from:Int,$to:Int,$ids:[Int]){
                      Page(page:$page,perPage:50){ pageInfo{ hasNextPage } airingSchedules(mediaId_in:$ids,airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){ episode airingAt media{ id type isAdult title{ romaji english } coverImage{ large } } } }
                    }
                    """
                    variables["ids"] = chunk
                } else {
                    query = """
                    query($page:Int,$from:Int,$to:Int){
                      Page(page:$page,perPage:50){ pageInfo{ hasNextPage } airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){ episode airingAt media{ id type isAdult title{ romaji english } coverImage{ large } } } }
                    }
                    """
                }
                let data = try await graph(query, variables)
                let pageObj = data["Page"] as? [String: Any]
                let list = (pageObj?["airingSchedules"] as? [[String: Any]]) ?? []
                for item in list {
                    guard let media = item["media"] as? [String: Any] else { continue }
                    if JSONValue.string(media["type"]) != nil && JSONValue.string(media["type"]) != "ANIME" { continue }
                    if (media["isAdult"] as? Bool) == true { continue }
                    let parsed = Media.parse(media)
                    guard parsed.id > 0, let episode = JSONValue.int(item["episode"]) else { continue }
                    rows.append(AiringSlot(mediaID: parsed.id, title: parsed.title, poster: parsed.cover, episode: episode, airingAt: JSONValue.int(item["airingAt"]) ?? 0))
                }
                let more = ((pageObj?["pageInfo"] as? [String: Any])?["hasNextPage"] as? Bool) ?? false
                if !more { break }
            }
        }
        return rows.sorted { $0.airingAt < $1.airingAt }
    }

    func notes(ids: [Int]) async throws -> (aired: [[String: Any]], upcoming: [[String: Any]]) {
        let now = Int(Date().timeIntervalSince1970)
        let query = """
        query($ids:[Int],$from:Int,$to:Int){
          aired:Page(perPage:50){ airingSchedules(mediaId_in:$ids,airingAt_greater:$from,airingAt_lesser:$to,sort:TIME_DESC){ episode airingAt media{ id title{ romaji english } coverImage{ large } } } }
          next:Page(perPage:50){ media(id_in:$ids){ id title{ romaji english } coverImage{ large } nextAiringEpisode{ episode airingAt } } }
        }
        """
        let data = try await graph(query, ["ids": ids, "from": now - 14 * 86400, "to": now])
        let aired = ((data["aired"] as? [String: Any])?["airingSchedules"] as? [[String: Any]]) ?? []
        let upcoming = ((data["next"] as? [String: Any])?["media"] as? [[String: Any]]) ?? []
        return (aired, upcoming)
    }

    private func graph(_ query: String, _ variables: [String: Any]) async throws -> [String: Any] {
        let body = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])
        let (data, http) = try await Net.data(
            from: endpoint,
            method: "POST",
            body: body,
            headers: ["Content-Type": "application/json"]
        )
        guard (200..<300).contains(http.statusCode) else {
            throw AddonError.message("AniList \(http.statusCode)")
        }
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let errors = root?["errors"] as? [Any], !errors.isEmpty, root?["data"] == nil {
            throw AddonError.message("AniList didn't answer")
        }
        return (root?["data"] as? [String: Any]) ?? [:]
    }

    private static let fields = """
    id idMal title { romaji english } coverImage { large color } bannerImage format status episodes season seasonYear averageScore genres nextAiringEpisode { episode airingAt } trailer { id site }
    """
}

struct SearchFilters: Equatable {
    var q: String = ""
    var genre: String?
    var season: String?
    var year: String?
    var format: String?
    var status: String?
    var country: String?
    var rating: String?
    var source: String?
    var episodes: String?
    var sort: String?
    var excludeWatching: Bool = false

    var activeCount: Int {
        [genre, season, year, format, status, country, rating, source, episodes, sort].compactMap { $0 }.count
            + (excludeWatching ? 1 : 0)
    }

    static let genres = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]
    static let seasons = [("WINTER", "Winter"), ("SPRING", "Spring"), ("SUMMER", "Summer"), ("FALL", "Fall")]
    static let formats = [("TV", "TV"), ("MOVIE", "Movie"), ("OVA", "OVA"), ("ONA", "ONA"), ("SPECIAL", "Special"), ("TV_SHORT", "TV short")]
    static let statuses = [("RELEASING", "Airing"), ("FINISHED", "Finished"), ("NOT_YET_RELEASED", "Not yet aired"), ("HIATUS", "On hiatus")]
    static let countries = [("JP", "Japan"), ("CN", "China"), ("KR", "South Korea"), ("TW", "Taiwan")]
    static let ratings = [("90", "9+"), ("80", "8+"), ("70", "7+"), ("60", "6+"), ("50", "5+")]
    static let sources = [("MANGA", "Manga"), ("LIGHT_NOVEL", "Light novel"), ("WEB_NOVEL", "Web novel"), ("NOVEL", "Novel"), ("ORIGINAL", "Original"), ("VIDEO_GAME", "Video game"), ("VISUAL_NOVEL", "Visual novel")]
    static let episodeBands = [("1-12", "1–12"), ("13-26", "13–26"), ("27-60", "27–60"), ("61-", "61+")]
    static let sorts = [("TRENDING_DESC", "Trending"), ("SCORE_DESC", "Top rated"), ("START_DATE_DESC", "Newest"), ("TITLE_ROMAJI", "A–Z"), ("POPULARITY_DESC", "Popular")]

    static var years: [String] {
        let end = Calendar.current.component(.year, from: Date()) + 1
        return stride(from: end, through: 1970, by: -1).map(String.init)
    }
}

extension Media {
    static func parse(_ dict: [String: Any]) -> Media {
        let title = dict["title"] as? [String: Any]
        let cover = dict["coverImage"] as? [String: Any]
        let next = dict["nextAiringEpisode"] as? [String: Any]
        let trailer = dict["trailer"] as? [String: Any]
        let studios = ((dict["studios"] as? [String: Any])?["nodes"] as? [Any])?.first as? [String: Any]
        let site = JSONValue.string(trailer?["site"])?.lowercased()
        return Media(
            id: JSONValue.int(dict["id"]) ?? 0,
            idMal: JSONValue.int(dict["idMal"]),
            romaji: JSONValue.string(title?["romaji"]),
            english: JSONValue.string(title?["english"]),
            cover: JSONValue.string(cover?["large"]),
            banner: JSONValue.string(dict["bannerImage"]),
            format: JSONValue.string(dict["format"]),
            status: JSONValue.string(dict["status"]),
            episodes: JSONValue.int(dict["episodes"]),
            season: JSONValue.string(dict["season"]),
            seasonYear: JSONValue.int(dict["seasonYear"]),
            averageScore: JSONValue.int(dict["averageScore"]),
            genres: JSONValue.strings(dict["genres"]),
            synopsis: JSONValue.string(dict["description"]).map(stripHTML),
            nextEpisode: JSONValue.int(next?["episode"]),
            nextAiringAt: JSONValue.int(next?["airingAt"]),
            trailerYouTube: site == "youtube" ? JSONValue.string(trailer?["id"]) : nil,
            studio: JSONValue.string(studios?["name"])
        )
    }
}

func stripHTML(_ raw: String) -> String {
    var s = raw.replacingOccurrences(of: "(?i)<br\\s*/?>", with: "\n", options: .regularExpression)
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

func currentSeason(now: Date = Date()) -> (season: String, year: Int, label: String) {
    let month = Calendar.current.component(.month, from: now)
    let names = ["WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER"]
    let season = names[month - 1]
    let year = month == 12 ? Calendar.current.component(.year, from: now) + 1 : Calendar.current.component(.year, from: now)
    let pretty = season.prefix(1) + season.dropFirst().lowercased()
    return (season, year, "\(pretty) \(year)")
}
