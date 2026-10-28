import Foundation

enum Net {
    static func data(from url: URL, method: String = "GET", body: Data? = nil, headers: [String: String] = [:], timeout: TimeInterval = 25) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.httpBody = body
        request.setValue("Kumo/1.0 (iPhone)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AddonError.message("Couldn't reach that link.")
        }
        return (data, http)
    }
}

enum AddonURLs {
    static func normalise(_ raw: String) -> String {
        var u = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if u.lowercased().hasPrefix("stremio://") {
            u = "https://" + u.dropFirst("stremio://".count)
        }
        if !u.lowercased().hasPrefix("http://") && !u.lowercased().hasPrefix("https://") {
            u = "https://" + u
        }
        return u
    }

    static func addonKey(_ raw: String) -> String {
        guard var parts = URLComponents(string: normalise(raw)) else { return raw }
        var path = parts.path
        while path.hasSuffix("/") { path.removeLast() }
        if !path.lowercased().hasSuffix("/manifest.json") { path += "/manifest.json" }
        parts.path = path
        parts.queryItems = parts.queryItems?.sorted { $0.name < $1.name }
        return parts.string ?? raw
    }

    static func resource(_ manifestURL: String, path: String) -> URL? {
        guard var parts = URLComponents(string: manifestURL) else { return nil }
        var base = parts.path
        if base.lowercased().hasSuffix("/manifest.json") {
            base.removeLast("/manifest.json".count)
        }
        while base.hasSuffix("/") { base.removeLast() }
        let extra = path.hasPrefix("/") ? String(path.dropFirst()) : path
        parts.path = base + "/" + extra
        return parts.url
    }
}

struct AddonClient {
    func manifest(from raw: String) async throws -> (url: String, manifest: Manifest) {
        let normalised = AddonURLs.normalise(raw)
        let manifestURL = normalised.lowercased().contains("manifest.json")
            ? normalised
            : (AddonURLs.resource(normalised, path: "manifest.json")?.absoluteString ?? normalised)
        guard let url = URL(string: manifestURL) else {
            throw AddonError.message("That link isn't an add-on manifest")
        }
        let (data, http) = try await Net.data(from: url)
        guard (200..<300).contains(http.statusCode) else {
            throw AddonError.message("The link answered with error \(http.statusCode)")
        }
        guard let manifest = Manifest.parse(data) else {
            throw AddonError.message("That link isn't an add-on manifest")
        }
        return (manifestURL, manifest)
    }

    func repository(from raw: String) async throws -> Repo {
        let normalised = AddonURLs.normalise(raw)
        guard let url = URL(string: normalised) else {
            throw AddonError.message("That link isn't a repository")
        }
        let (data, http) = try await Net.data(from: url)
        guard (200..<300).contains(http.statusCode) else {
            throw AddonError.message("The link answered with error \(http.statusCode)")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) else {
            throw AddonError.message("No add-ons found at that link")
        }
        let object = json as? [String: Any]
        let list = (json as? [Any]) ?? (object?["addons"] as? [Any]) ?? (object?["plugins"] as? [Any]) ?? []
        let entries: [RepoEntry] = list.compactMap { item in
            if let s = item as? String {
                return RepoEntry(url: s, name: s, description: "")
            }
            guard let dict = item as? [String: Any] else { return nil }
            let manifest = dict["manifest"] as? [String: Any]
            let url = JSONValue.string(dict["transportUrl"]) ?? JSONValue.string(dict["manifestUrl"]) ?? JSONValue.string(dict["url"])
            guard let url, !url.isEmpty else { return nil }
            let name = JSONValue.string(manifest?["name"]) ?? JSONValue.string(dict["name"]) ?? url
            let description = JSONValue.string(manifest?["description"]) ?? JSONValue.string(dict["description"]) ?? ""
            return RepoEntry(url: url, name: name, description: description)
        }
        guard !entries.isEmpty else { throw AddonError.message("No add-ons found at that link") }
        let name = JSONValue.string(object?["name"]) ?? URL(string: normalised)?.host ?? "Repository"
        return Repo(url: normalised, name: name, entries: entries)
    }

    func catalog(_ addon: InstalledAddon, _ catalog: Catalog, skip: Int = 0) async throws -> [MetaPreview] {
        let extra = skip > 0 ? "/skip=\(skip)" : ""
        let path = "catalog/\(catalog.type.encodePath)/\(catalog.id.encodePath)\(extra).json"
        guard let url = AddonURLs.resource(addon.url, path: path) else { return [] }
        return try await metas(url)
    }

    func meta(_ addon: InstalledAddon, type: String, id: String) async throws -> MetaPreview? {
        guard let url = AddonURLs.resource(addon.url, path: "meta/\(type.encodePath)/\(id.encodePath).json") else { return nil }
        let (data, http) = try await Net.data(from: url)
        guard (200..<300).contains(http.statusCode) else { return nil }
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard let meta = root?["meta"] as? [String: Any] else { return nil }
        return MetaPreview.parse(meta, fallbackType: type)
    }

    func streams(_ addon: InstalledAddon, type: String, id: String) async throws -> [Stream] {
        guard let url = AddonURLs.resource(addon.url, path: "stream/\(type.encodePath)/\(id.encodePath).json") else { return [] }
        let (data, http) = try await Net.data(from: url)
        guard (200..<300).contains(http.statusCode) else {
            throw AddonError.message("HTTP \(http.statusCode)")
        }
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let list = root?["streams"] as? [Any] ?? []
        return list.compactMap { ($0 as? [String: Any]).map(Stream.parse) }
    }

    func subtitles(_ addon: InstalledAddon, type: String, id: String) async -> [SubtitleLink] {
        guard let url = AddonURLs.resource(addon.url, path: "subtitles/\(type.encodePath)/\(id.encodePath).json") else { return [] }
        guard let (data, http) = try? await Net.data(from: url), (200..<300).contains(http.statusCode) else { return [] }
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let list = root?["subtitles"] as? [Any] ?? []
        return list.compactMap { item in
            guard let dict = item as? [String: Any], let url = JSONValue.string(dict["url"]), !url.isEmpty else { return nil }
            return SubtitleLink(url: url, lang: JSONValue.string(dict["lang"]) ?? "")
        }
    }

    private func metas(_ url: URL) async throws -> [MetaPreview] {
        let (data, http) = try await Net.data(from: url)
        guard (200..<300).contains(http.statusCode) else {
            throw AddonError.message("HTTP \(http.statusCode)")
        }
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let list = root?["metas"] as? [Any] ?? []
        return list.compactMap { ($0 as? [String: Any]).map { MetaPreview.parse($0, fallbackType: "") } }
    }
}

extension Manifest {
    static func parse(_ data: Data) -> Manifest? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        guard let id = JSONValue.string(obj["id"]), obj["resources"] != nil else { return nil }
        let resources = parseResources(obj["resources"])
        guard !resources.isEmpty else { return nil }
        let types = JSONValue.strings(obj["types"])
        let prefixes = obj.keys.contains("idPrefixes") ? JSONValue.strings(obj["idPrefixes"]) : nil
        return Manifest(
            id: id,
            name: JSONValue.string(obj["name"])?.nilIfEmpty ?? "Add-on",
            version: JSONValue.string(obj["version"]) ?? "",
            description: JSONValue.string(obj["description"]) ?? "",
            logo: JSONValue.string(obj["logo"]),
            resources: resources,
            types: types,
            idPrefixes: prefixes,
            catalogs: parseCatalogs(obj["catalogs"])
        )
    }

    private static func parseResources(_ any: Any?) -> [AddonResource] {
        guard let list = any as? [Any] else { return [] }
        return list.compactMap { item in
            if let name = item as? String, !name.isEmpty {
                return AddonResource(name: name, types: nil, idPrefixes: nil)
            }
            guard let dict = item as? [String: Any], let name = JSONValue.string(dict["name"]), !name.isEmpty else { return nil }
            let types = dict.keys.contains("types") ? JSONValue.strings(dict["types"]) : nil
            let prefixes = dict.keys.contains("idPrefixes") ? JSONValue.strings(dict["idPrefixes"]) : nil
            return AddonResource(name: name, types: types, idPrefixes: prefixes)
        }
    }

    private static func parseCatalogs(_ any: Any?) -> [Catalog] {
        guard let list = any as? [Any] else { return [] }
        return list.compactMap { item in
            guard let dict = item as? [String: Any],
                  let id = JSONValue.string(dict["id"]),
                  let type = JSONValue.string(dict["type"]) else { return nil }
            var required = false
            if let extras = dict["extra"] as? [Any] {
                required = extras.contains { item in
                    guard let dict = item as? [String: Any] else { return false }
                    if let flag = dict["isRequired"] as? Bool { return flag }
                    if let n = dict["isRequired"] as? NSNumber { return n.boolValue }
                    return false
                }
            }
            if let extraRequired = dict["extraRequired"] as? [Any], !extraRequired.isEmpty { required = true }
            return Catalog(
                id: id,
                type: type,
                name: JSONValue.string(dict["name"]) ?? "",
                requiresExtra: required
            )
        }
    }

    func spec(_ name: String) -> (types: [String], prefixes: [String]?)? {
        guard let resource = resources.first(where: { $0.name == name }) else { return nil }
        return (resource.types ?? types, resource.idPrefixes ?? idPrefixes)
    }

    func handles(_ name: String, id: String) -> Bool {
        guard let spec = spec(name) else { return false }
        guard let prefixes = spec.prefixes else { return true }
        if prefixes.isEmpty { return false }
        return prefixes.contains { id.hasPrefix($0) }
    }
}

extension Stream {
    static func parse(_ dict: [String: Any]) -> Stream {
        let hints = dict["behaviorHints"] as? [String: Any]
        let subs = (dict["subtitles"] as? [Any])?.compactMap { item -> SubtitleLink? in
            guard let dict = item as? [String: Any], let url = JSONValue.string(dict["url"]), !url.isEmpty else { return nil }
            return SubtitleLink(url: url, lang: JSONValue.string(dict["lang"]) ?? "")
        } ?? []
        return Stream(
            name: JSONValue.string(dict["name"]),
            title: JSONValue.string(dict["title"]),
            description: JSONValue.string(dict["description"]),
            url: JSONValue.string(dict["url"]),
            externalUrl: JSONValue.string(dict["externalUrl"]),
            ytId: JSONValue.string(dict["ytId"]),
            infoHash: JSONValue.string(dict["infoHash"]) ?? JSONValue.string(dict["info_hash"]),
            filename: JSONValue.string(hints?["filename"]),
            bingeGroup: JSONValue.string(hints?["bingeGroup"]),
            subtitles: subs
        )
    }
}

extension MetaPreview {
    static func parse(_ dict: [String: Any], fallbackType: String) -> MetaPreview {
        let id = JSONValue.string(dict["id"]) ?? UUID().uuidString
        let videos = (dict["videos"] as? [Any])?.compactMap { item -> MetaVideo? in
            guard let dict = item as? [String: Any] else { return nil }
            let vid = JSONValue.string(dict["id"]) ?? UUID().uuidString
            let title = JSONValue.string(dict["title"]) ?? JSONValue.string(dict["name"]) ?? "Episode"
            return MetaVideo(
                id: vid,
                title: title,
                season: JSONValue.int(dict["season"]),
                episode: JSONValue.int(dict["episode"]),
                thumbnail: JSONValue.string(dict["thumbnail"])
            )
        } ?? []
        return MetaPreview(
            id: id,
            type: JSONValue.string(dict["type"])?.nilIfEmpty ?? fallbackType,
            name: JSONValue.string(dict["name"]) ?? "Untitled",
            poster: JSONValue.string(dict["poster"]),
            background: JSONValue.string(dict["background"]),
            description: JSONValue.string(dict["description"]),
            releaseInfo: JSONValue.string(dict["releaseInfo"]),
            imdbRating: JSONValue.string(dict["imdbRating"]),
            genres: JSONValue.strings(dict["genres"]),
            videos: videos.sorted { a, b in
                if (a.season ?? 0) != (b.season ?? 0) { return (a.season ?? 0) < (b.season ?? 0) }
                return (a.episode ?? 0) < (b.episode ?? 0)
            }
        )
    }
}

private extension String {
    var encodePath: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}
