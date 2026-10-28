import Foundation

struct SkipWindow: Equatable {
    var start: Double
    var end: Double
}

struct SkipTimes: Equatable {
    var op: SkipWindow?
    var ed: SkipWindow?
}

enum AniSkip {
    static func fetch(malID: Int, episode: Int, duration: Double?) async -> SkipTimes {
        guard malID > 0, episode > 0 else { return SkipTimes() }
        var query = ["types[]=op", "types[]=ed"]
        if let duration, duration > 1 {
            query.append("episodeLength=\(Int(duration.rounded()))")
        }
        guard let url = URL(string: "https://api.aniskip.com/v2/skip-times/\(malID)/\(episode)?\(query.joined(separator: "&"))"),
              let (data, http) = try? await Net.data(from: url),
              (200..<300).contains(http.statusCode),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["found"] as? Bool) == true,
              let results = root["results"] as? [Any] else { return SkipTimes() }
        var times = SkipTimes()
        for item in results {
            guard let dict = item as? [String: Any],
                  let type = JSONValue.string(dict["skipType"]),
                  let interval = dict["interval"] as? [String: Any],
                  let start = JSONValue.double(interval["startTime"]),
                  let end = JSONValue.double(interval["endTime"]),
                  end > start else { continue }
            if type == "op" { times.op = SkipWindow(start: start, end: end) }
            if type == "ed" { times.ed = SkipWindow(start: start, end: end) }
        }
        return times
    }

    static func contains(_ time: Double, _ window: SkipWindow?) -> Bool {
        guard let window else { return false }
        return time >= window.start && time < window.end - 0.35
    }
}
