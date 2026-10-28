import Foundation

/// Filler marks come from AniFillerPedia when it answers, and from the public
/// AniFiller show files when that call cannot be made. A miss just means no marks.
enum FillerClient {
    static func episodes(malID: Int) async -> Set<Int> {
        if let marks = await pedia(malID: malID) { return marks }
        return await anira(malID: malID) ?? []
    }

    private static func pedia(malID: Int) async -> Set<Int>? {
        guard let url = URL(string: "https://anifillerpedia.wiki/api/v1/series?mal_id=\(malID)"),
              let (data, http) = try? await Net.data(from: url),
              (200..<300).contains(http.statusCode),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let items = obj["items"] as? [[String: Any]],
              let seriesID = JSONValue.int(items.first?["id"]) else { return nil }
        guard let episodeURL = URL(string: "https://anifillerpedia.wiki/api/v1/series/\(seriesID)/episodes"),
              let (episodeData, episodeHTTP) = try? await Net.data(from: episodeURL),
              (200..<300).contains(episodeHTTP.statusCode),
              let list = (try? JSONSerialization.jsonObject(with: episodeData)) as? [[String: Any]] else { return nil }
        return marks(in: list, numberKey: "episode_number", statusKey: "status")
    }

    private static func anira(malID: Int) async -> Set<Int>? {
        guard let readmeURL = URL(string: "https://raw.githubusercontent.com/AniraTeam/AniFiller/main/README.md"),
              let (data, http) = try? await Net.data(from: readmeURL),
              (200..<300).contains(http.statusCode),
              let text = String(data: data, encoding: .utf8) else { return nil }
        guard let file = fileName(in: text, malID: malID),
              let showURL = URL(string: "https://cdn.jsdelivr.net/gh/AniraTeam/AniFiller@main/data/shows/\(file)"),
              let (showData, showHTTP) = try? await Net.data(from: showURL),
              (200..<300).contains(showHTTP.statusCode),
              let show = (try? JSONSerialization.jsonObject(with: showData)) as? [String: Any],
              let episodes = show["episodes"] as? [[String: Any]] else { return nil }
        return marks(in: episodes, numberKey: "episode", statusKey: "type")
    }

    private static func marks(in episodes: [[String: Any]], numberKey: String, statusKey: String) -> Set<Int> {
        var set = Set<Int>()
        for episode in episodes {
            guard JSONValue.string(episode[statusKey]) == "filler", let number = JSONValue.int(episode[numberKey]), number > 0 else { continue }
            set.insert(number)
        }
        return set
    }

    private static func fileName(in markdown: String, malID: Int) -> String? {
        let pattern = #"\|\s*\[`([^`]+\.json)`\][^|\n]*\|\s*[^|\n]+\|\s*(\d+)\s*\|"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(markdown.startIndex..., in: markdown)
        let want = String(malID)
        for match in regex.matches(in: markdown, range: range) {
            guard match.numberOfRanges == 3,
                  let fileRange = Range(match.range(at: 1), in: markdown),
                  let idRange = Range(match.range(at: 2), in: markdown),
                  String(markdown[idRange]) == want else { continue }
            return String(markdown[fileRange])
        }
        return nil
    }
}
