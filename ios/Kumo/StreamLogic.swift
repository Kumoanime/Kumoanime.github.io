import Foundation

/// Stream ordering, Stremio id parsing, and the rules for when a Comet/Real-Debrid
/// response is a real file versus an error. Playback tries a failed source's next
/// cached neighbour once and does not loop. A tapped source is never replaced.
enum StreamLogic {
    private static let videoExt = "mkv|mp4|m4v|webm|avi|wmv|flv|m3u8|mov|ts"
    private static let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    static func container(of stream: Stream) -> String {
        if let hint = stream.filename, let ext = firstExt(in: hint) { return ext }
        if let url = stream.url, let ext = extAtEnd(of: url.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? url) {
            return ext
        }
        let blob = [stream.title, stream.description, stream.name].compactMap { $0 }.joined(separator: " ")
        return firstExt(in: blob) ?? ""
    }

    static func isDebridResolver(_ url: String?) -> Bool {
        let u = url ?? ""
        if match("/playback/[a-z2-7]{32}(?:/|$|\\?)", in: u) { return true }
        if match("/playback/[a-f0-9]{40,80}(?:/|$|\\?)", in: u) { return true }
        if match("/resolve/[^?\\s]*real-?debrid/", in: u) { return true }
        if match("/real-?debrid/[^/\\s]+/[a-f0-9]{40}(?:/|$)", in: u) { return true }
        return false
    }

    static func isDirectDebridFile(_ url: String?) -> Bool {
        match("download\\.real-debrid\\.com|//[^/]*real-debrid\\.com/d/", in: url ?? "")
    }

    static func isDebridCDN(_ url: URL) -> Bool {
        let host = (url.host ?? "").lowercased()
        if host.contains("real-debrid.com") { return true }
        let hints = ["premiumize", "alldebrid", "debrid.it", "torbox", "offcloud"]
        return hints.contains { host.contains($0) }
    }

    static func isDebridStream(_ stream: Stream) -> Bool {
        if isDebridResolver(stream.url) || isDirectDebridFile(stream.url) { return true }
        return match("\\[(RD|AD|PM|TB|DL)[^\\]]*\\]", in: stream.name ?? "")
    }

    static func isCached(_ stream: Stream) -> Bool {
        let name = "\(stream.name ?? "") \(stream.title ?? "")"
        if name.contains("⚡") || name.contains("⚡️") { return true }
        if match("\\[(RD|AD|PM|TB|DL)\\+\\]", in: name) { return true }
        if match("\\bRD\\+\\b|\\bcached\\b", in: name) && !match("not cached|uncached", in: name) { return true }
        return false
    }

    static func isUncached(_ stream: Stream) -> Bool {
        if isCached(stream) { return false }
        let name = "\(stream.name ?? "") \(stream.title ?? "")"
        return name.contains("⬇️") || name.contains("↓") || match("\\[(RD|AD|PM) download\\]|uncached|not cached", in: name)
    }

    static func audio(of stream: Stream) -> AudioKind {
        let t = "\(stream.name ?? "") \(stream.title ?? "") \(stream.description ?? "")"
        if match("\\bdub(bed)?\\b|\\beng(lish)? ?dub|\\bdual\\b", in: t) { return .dub }
        if match("\\bsub(bed|s)?\\b|\\bsoft ?sub|\\bhard ?sub", in: t) { return .sub }
        return .other
    }

    static func kindLabel(_ stream: Stream) -> String {
        if stream.ytId?.isEmpty == false { return "YouTube" }
        switch container(of: stream) {
        case "m3u8": return "HLS"
        case "mkv": return "MKV"
        case "webm": return "WebM"
        case "mp4", "m4v": return "MP4"
        default:
            if stream.url?.isEmpty == false { return isDebridStream(stream) ? "Debrid" : "Video" }
            if stream.externalUrl?.isEmpty == false { return "Opens site" }
            if stream.infoHash?.isEmpty == false { return "Torrent" }
            return ""
        }
    }

    /// Sub before dub. Inside that, a cached source (⚡) outranks an uncached one.
    /// MKV is not penalised: VLC on the phone can play it.
    static func rank(_ stream: Stream) -> Int {
        if stream.url?.isEmpty != false && stream.ytId?.isEmpty != false && stream.externalUrl?.isEmpty != false {
            return -1
        }
        if isCached(stream) { return 100 }
        if isUncached(stream) { return 10 }
        return 40
    }

    static func order(_ rows: [StreamRow]) -> [StreamRow] {
        let audioRank: [AudioKind: Int] = [.sub: 0, .other: 1, .dub: 2]
        return rows.sorted { a, b in
                let ar = audioRank[a.audio] ?? 1
                let br = audioRank[b.audio] ?? 1
                if ar != br { return ar < br }
                let rs = rank(b.stream) - rank(a.stream)
                if rs != 0 { return rs > 0 }
                return a.index < b.index
            }
    }

    /// `explicit` keeps only the row the person tapped.
    /// Otherwise each index appears once. Uncached rows are left out when `skipUncached` is set.
    static func playbackOrder(_ rows: [StreamRow], start: Int?, explicit: Bool, skipUncached: Bool) -> [StreamRow] {
        let ranked = order(rows)
        if explicit {
            guard let start else { return [] }
            return ranked.filter { $0.index == start }
        }
        let list = skipUncached ? ranked.filter { !isUncached($0.stream) } : ranked
        var seen = Set<Int>()
        var unique: [StreamRow] = []
        for row in list where seen.insert(row.index).inserted {
            unique.append(row)
        }
        guard let start, let first = unique.firstIndex(where: { $0.index == start }) else { return unique }
        return [unique[first]] + unique.enumerated().filter { $0.offset != first }.map(\.element)
    }

    /// Automatic playback list: cached sources with a direct link, sub before dub.
    /// If nothing is cached, the same order including uncached links, so the first tap-free play still has a candidate.
    static func autoCandidates(_ rows: [StreamRow]) -> [StreamRow] {
        let cached = playbackOrder(rows, start: nil, explicit: false, skipUncached: true)
            .filter { $0.stream.url?.isEmpty == false && isCached($0.stream) }
        if !cached.isEmpty { return cached }
        return playbackOrder(rows, start: nil, explicit: false, skipUncached: false)
            .filter { $0.stream.url?.isEmpty == false }
    }

    static func displayGroups(_ rows: [StreamRow]) -> [(AudioKind, String, [StreamRow])] {
        let labels: [(AudioKind, String)] = [
            (.sub, "SUB"),
            (.dub, "DUB"),
            (.other, rows.contains { $0.audio != .other } ? "Other" : "Sources"),
        ]
        return labels.compactMap { kind, label in
            let list = rows.filter { $0.audio == kind }.sorted { a, b in
                let cached = (isCached(a.stream) ? 1 : 0) - (isCached(b.stream) ? 1 : 0)
                if cached != 0 { return cached > 0 }
                let rs = rank(b.stream) - rank(a.stream)
                if rs != 0 { return rs > 0 }
                return a.index < b.index
            }
            return list.isEmpty ? nil : (kind, label, list)
        }
    }

    // MARK: hashes

    static func hash(of stream: Stream) -> String {
        let direct = normalizeInfoHash(stream.infoHash ?? "")
        if !direct.isEmpty { return direct }
        let pieces = (stream.bingeGroup ?? "").split(separator: "|").map(String.init)
        for piece in pieces.reversed() {
            let fromGroup = normalizeInfoHash(piece)
            if !fromGroup.isEmpty { return fromGroup }
        }
        let u = stream.url ?? ""
        if let m = firstGroup("/playback/([a-z0-9]{32,80})(?:/|$|\\?)", in: u) { return normalizeInfoHash(m) }
        if let m = firstGroup("/real-?debrid/[^/]+/([a-f0-9]{40})(?:/|$)", in: u) { return normalizeInfoHash(m) }
        if let m = firstGroup("[?&](?:hash|infoHash|info_hash)=([a-z0-9]{32,80})\\b", in: u) { return normalizeInfoHash(m) }
        return ""
    }

    struct PlaybackParts {
        var hash: String
        var serviceIndex: String
        var fileIndex: String?
        var season: Int?
        var episode: Int?
    }

    static func playbackParts(_ url: String?) -> PlaybackParts? {
        guard let groups = groups("/playback/([a-z0-9]{32,80})/([^/]+)/([^/]+)/([^/]+)/([^/?#]+)", in: url ?? ""),
              groups.count >= 6 else { return nil }
        let hash = normalizeInfoHash(groups[1])
        guard !hash.isEmpty else { return nil }
        func num(_ value: String) -> Int? {
            let s = value.trimmingCharacters(in: .whitespaces)
            guard s.allSatisfy({ $0 == "-" || $0.isNumber }), s != "-", !s.isEmpty else { return nil }
            return Int(s)
        }
        return PlaybackParts(
            hash: hash,
            serviceIndex: groups[2],
            fileIndex: groups[3] == "n" ? nil : groups[3],
            season: num(groups[4]),
            episode: num(groups[5])
        )
    }

    static func normalizeInfoHash(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let btih = firstGroup("btih:([a-z0-9]+)", in: s) { s = btih }
        if s.range(of: "^[a-f0-9]{80}$", options: [.regularExpression, .caseInsensitive]) != nil {
            let decoded = hexASCII(s)
            if decoded.range(of: "^[a-f0-9]{40}$", options: [.regularExpression, .caseInsensitive]) != nil {
                s = decoded
            }
        }
        if s.range(of: "^[a-z2-7]{32}$", options: [.regularExpression, .caseInsensitive]) != nil {
            let hex = base32ToHex(s)
            if hex.range(of: "^[a-f0-9]{40}$", options: [.regularExpression, .caseInsensitive]) != nil {
                s = hex
            }
        }
        if s.range(of: "^[a-f0-9]{40}$", options: [.regularExpression, .caseInsensitive]) != nil {
            return s.lowercased()
        }
        return ""
    }

    // MARK: tokens inside an add-on install link

    struct FoundToken: Equatable {
        var token: String
        var from: String
    }

    static func token(from url: String) -> FoundToken? {
        if let tor = firstGroup("real-?debrid=([^/|&\\s]+)", in: url), tor.count > 8, !tor.lowercased().hasPrefix("http") {
            return FoundToken(token: tor.removingPercentEncoding ?? tor, from: "Torrentio")
        }
        let parts = URL(string: url)?.path.split(separator: "/").map(String.init) ?? url.split(separator: "/").map(String.init)
        for part in parts {
            if part.count < 16 || part == "manifest.json" { continue }
            if let token = token(fromConfig: b64JSON(part)) {
                return FoundToken(token: token, from: "Comet")
            }
        }
        if let inPath = firstGroup("/real-?debrid/([^/]{9,})/", in: url),
           inPath.range(of: "^[a-f0-9]{40}$", options: [.regularExpression, .caseInsensitive]) == nil {
            return FoundToken(token: inPath.removingPercentEncoding ?? inPath, from: "add-on")
        }
        return nil
    }

    static func tokenFromAddons(_ addons: [InstalledAddon]) -> FoundToken? {
        for addon in addons where addon.enabled {
            if let found = token(from: addon.url) { return found }
        }
        return nil
    }

    // MARK: redirect classification

    struct ResolveSnapshot {
        var original: URL
        var hops: [URL]
        var finalURL: URL
        var status: Int
        var contentType: String
        var totalBytes: Int?
        var complete: Bool
        var body: String
        var debridResolver: Bool
    }

    enum ResolveOutcome: Equatable {
        case play(URL, treatShortAsError: Bool)
        case failure(PlaybackFailure)
    }

    static func classify(_ snap: ResolveSnapshot) -> ResolveOutcome {
        for url in [snap.original] + snap.hops + [snap.finalURL] {
            if let title = slateTitle(from: url) {
                return .failure(PlaybackFailure(kind: .slate, message: title))
            }
        }
        if let rd = realDebridMessage(status: snap.status, contentType: snap.contentType, body: snap.body, url: snap.finalURL) {
            return .failure(PlaybackFailure(kind: .realDebrid, message: rd))
        }
        let video = isVideo(contentType: snap.contentType, url: snap.finalURL)
        let cdn = isDebridCDN(snap.finalURL) || isDirectDebridFile(snap.finalURL.absoluteString)
        if snap.debridResolver && !cdn && video && snap.complete, let bytes = snap.totalBytes, bytes > 0, bytes < 6_000_000 {
            return .failure(PlaybackFailure(
                kind: .statusClip,
                message: "The add-on sent an error clip instead of the episode."
            ))
        }
        if snap.status >= 400 {
            return .failure(PlaybackFailure(kind: .http, message: "The source returned HTTP \(snap.status)."))
        }
        let type = snap.contentType.lowercased()
        if type.contains("html") || type.contains("json") || type.hasPrefix("text/") {
            return .failure(PlaybackFailure(kind: .http, message: "The source didn't return a video file."))
        }
        if video || ((200..<400).contains(snap.status) && (type.isEmpty || type.contains("octet-stream") || type.contains("video"))) {
            return .play(snap.finalURL, treatShortAsError: snap.debridResolver && !cdn)
        }
        if (200..<400).contains(snap.status) {
            return .play(snap.finalURL, treatShortAsError: snap.debridResolver && !cdn)
        }
        return .failure(PlaybackFailure(kind: .other, message: "That source didn't respond."))
    }

    static func slateTitle(from url: URL) -> String? {
        let host = (url.host ?? "").lowercased()
        let absolute = url.absoluteString.lowercased()
        let isSlate = host == "slate.elfhosted.com" || host.hasSuffix(".slate.elfhosted.com") || absolute.contains("slate.elfhosted.com")
        guard isSlate else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name.compare(name, options: .caseInsensitive) == .orderedSame }?
                .value?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nilIfEmpty
        }
        let parts = [value("title"), value("subtitle") ?? value("description") ?? value("message") ?? value("text")]
            .compactMap { $0 }
        if parts.isEmpty { return "The add-on sent an error slate instead of the episode." }
        return parts.joined(separator: " — ")
    }

    static func totalLength(status: Int, headers: [String: String]) -> (bytes: Int?, complete: Bool) {
        let range = headers.first { $0.key.caseInsensitiveCompare("Content-Range") == .orderedSame }?.value ?? ""
        if let slash = range.split(separator: "/").last {
            let total = String(slash).trimmingCharacters(in: .whitespaces)
            if total != "*", let n = Int(total), n > 0 {
                return (n, true)
            }
            return (nil, false)
        }
        if status == 200, let raw = headers.first(where: { $0.key.caseInsensitiveCompare("Content-Length") == .orderedSame })?.value,
           let n = Int(raw), n > 0 {
            return (n, true)
        }
        return (nil, false)
    }

    // MARK: torrent file pick (used when a source has a hash but no link)

    struct TorrentFile: Equatable {
        var id: Int
        var path: String
        var bytes: Int
        var selected: Bool
    }

    static func pickTorrentFile(_ files: [TorrentFile], fileIndex: String?, episode: Int?, season: Int?) -> TorrentFile? {
        let videos = files.filter { isVideoPath($0.path) }
        guard !videos.isEmpty else { return nil }
        if let fileIndex, !fileIndex.isEmpty, fileIndex != "n", let match = videos.first(where: { String($0.id) == fileIndex }) {
            return match
        }
        let ranked = videos.map { file -> (TorrentFile, Int) in
            (file, episodeScore(file.path, episode: episode, season: season))
        }.sorted { a, b in
            if a.1 != b.1 { return a.1 > b.1 }
            return a.0.bytes > b.0.bytes
        }
        if let best = ranked.first, best.1 > 0 { return best.0 }
        return videos.count == 1 ? videos[0] : nil
    }

    static func friendlyDebrid(status: Int, code: Int, message: String) -> String {
        switch rdKind(status: status, code: code, message: message) {
        case "auth":
            return "Real-Debrid refused the token. Reconnect it in the add-on, or paste a new token under Add-ons."
        case "infringing":
            return "Real-Debrid blocked that file (copyright filter)."
        case "rate":
            return "Real-Debrid asked us to slow down. Wait a moment and try again."
        case "ip":
            return "Real-Debrid rejected the network this phone is on."
        case "unavailable":
            return "Real-Debrid doesn't have a playable copy of that file."
        default:
            return "Real-Debrid didn't return a playable stream."
        }
    }

    // MARK: private

    private static func realDebridMessage(status: Int, contentType: String, body: String, url: URL) -> String? {
        let host = (url.host ?? "").lowercased()
        let onRD = host.contains("real-debrid.com")
        let parsed = jsonError(body)
        if onRD, let parsed {
            return friendlyDebrid(status: status, code: parsed.code, message: parsed.message)
        }
        if onRD && (status >= 400 || contentType.lowercased().contains("html") || contentType.lowercased().contains("json")) {
            if let parsed { return friendlyDebrid(status: status, code: parsed.code, message: parsed.message) }
            if status >= 400 || contentType.lowercased().contains("html") || contentType.lowercased().contains("json") {
                return friendlyDebrid(status: status, code: 0, message: body)
            }
        }
        if let parsed, body.lowercased().contains("infringing") || body.lowercased().contains("bad_token") {
            return friendlyDebrid(status: status, code: parsed.code, message: parsed.message)
        }
        return nil
    }

    private static func jsonError(_ body: String) -> (message: String, code: Int)? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let message = JSONValue.string(obj["error"]) ?? JSONValue.string(obj["error_code"]) ?? ""
        guard !message.isEmpty || obj["error"] != nil || obj["error_code"] != nil else { return nil }
        let code = JSONValue.int(obj["error_code"]) ?? 0
        return (message.isEmpty ? "error" : message, code)
    }

    private static func rdKind(status: Int, code: Int, message: String) -> String {
        let m = message.lowercased()
        if status == 401 || code == 8 || code == 9 || code == 14 || m.contains("bad_token") || m.contains("bad token") || m.contains("permission") || m.contains("account_locked") {
            return "auth"
        }
        if code == 35 || status == 451 || m.contains("infring") { return "infringing" }
        if code == 34 || status == 429 || code == 5 || m.contains("too many") || m.contains("slow_down") || m.contains("slow down") {
            return "rate"
        }
        if code == 22 || m.contains("ip_not_allowed") || m.contains("ip address not allowed") { return "ip" }
        if code == 24 || code == 25 || code == 16 || m.contains("unavailable") || m.contains("file_unavailable") {
            return "unavailable"
        }
        return "error"
    }

    private static func isVideo(contentType: String, url: URL) -> Bool {
        let type = contentType.lowercased()
        if type.contains("video") || type.contains("octet-stream") || type.contains("matroska") || type.contains("mpegurl") {
            return true
        }
        return extAtEnd(of: url.path) != nil
    }

    private static func isVideoPath(_ path: String) -> Bool {
        let clean = path.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? path
        guard extAtEnd(of: clean) != nil else { return false }
        return !match("sample|trailer|\\bncop\\b|\\bnced\\b", in: path)
    }

    private static func episodeScore(_ path: String, episode: Int?, season: Int?) -> Int {
        guard let episode else { return 0 }
        let n = path
        let ep = String(episode)
        var score = 0
        if let season, match("s0*\(season)[. _-]*e0*\(episode)\\b", in: n) { score += 100 }
        if match("(?:^|[^a-z0-9])e0*\(episode)\\b", in: n) { score += 80 }
        if match(" - 0*\(episode)(?:[^0-9]|$)", in: n) { score += 70 }
        let ee = String(format: "%02d", episode)
        if ee != ep && match("(?:^|[^0-9])\(ee)(?:[^0-9]|$)", in: n) { score += 40 }
        return score
    }

    private static func token(fromConfig object: [String: Any]?) -> String? {
        guard let object else { return nil }
        let list = (object["debridServices"] as? [Any]) ?? (object["debrid_services"] as? [Any]) ?? []
        for entry in list {
            guard let dict = entry as? [String: Any] else { continue }
            let service = (JSONValue.string(dict["service"]) ?? JSONValue.string(dict["name"]) ?? "")
            if service.range(of: "real-?debrid", options: [.regularExpression, .caseInsensitive]) != nil,
               let key = JSONValue.string(dict["apiKey"]), key.count > 8 {
                return key
            }
        }
        let service = JSONValue.string(object["debridService"]) ?? ""
        if service.range(of: "real-?debrid", options: [.regularExpression, .caseInsensitive]) != nil,
           let key = JSONValue.string(object["debridApiKey"]), key.count > 8 {
            return key
        }
        for key in ["rdToken", "rd_token", "realdebrid", "realDebridApiKey"] {
            if let value = JSONValue.string(object[key]), value.count > 8 { return value }
        }
        return nil
    }

    private static func b64JSON(_ segment: String) -> [String: Any]? {
        var s = segment.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        guard let data = Data(base64Encoded: s) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func base32ToHex(_ input: String) -> String {
        let alphabet = b32
        let s = input.replacingOccurrences(of: "=", with: "").uppercased()
        var bits = 0
        var value = 0
        var out: [UInt8] = []
        for ch in s {
            guard let idx = alphabet.firstIndex(of: ch) else { return "" }
            value = (value << 5) | idx
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((value >> bits) & 255))
            }
        }
        return out.map { String(format: "%02x", $0) }.joined()
    }

    private static func hexASCII(_ input: String) -> String {
        let s = input
        guard s.count % 2 == 0, s.range(of: "^[a-f0-9]+$", options: [.regularExpression, .caseInsensitive]) != nil else { return "" }
        var text = ""
        var index = s.startIndex
        while index < s.endIndex {
            let next = s.index(index, offsetBy: 2)
            guard let code = Int(s[index..<next], radix: 16), (32...126).contains(code) else { return "" }
            text.append(Character(UnicodeScalar(code)!))
            index = next
        }
        return text
    }

    private static func firstExt(in text: String) -> String? {
        firstGroup("\\.(\(videoExt))\\b", in: text)?.lowercased()
    }

    private static func extAtEnd(of path: String) -> String? {
        firstGroup("\\.(\(videoExt))$", in: path)?.lowercased()
    }

    private static func match(_ pattern: String, in text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func firstGroup(_ pattern: String, in text: String) -> String? {
        groups(pattern, in: text)?.dropFirst().first
    }

    private static func groups(_ pattern: String, in text: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = re.firstMatch(in: text, options: [], range: range) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            guard let r = Range(m.range(at: i), in: text) else { return "" }
            return String(text[r])
        }
    }
}
