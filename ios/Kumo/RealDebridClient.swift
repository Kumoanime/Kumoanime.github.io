import Foundation

/// Asks Real-Debrid for the original file from this phone when a source has a torrent
/// hash but no link. VLC plays that file. There is no HLS transcode and no proxy:
/// the API call leaves the device, so the download is tied to the phone's address.
enum RealDebridClient {
    static func resolveOriginal(hash: String, fileIndex: String?, season: Int?, episode: Int?, token: String) async -> StreamLogic.ResolveOutcome {
        let hash = hash.lowercased()
        guard hash.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
            return .failure(PlaybackFailure(kind: .other, message: "This source has no torrent id to resolve."))
        }
        do {
            let added = try await request(token: token, method: "POST", path: "/torrents/addMagnet", params: ["magnet": "magnet:?xt=urn:btih:" + hash])
            guard let id = JSONValue.string(added["id"]), !id.isEmpty else {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "Real-Debrid didn't accept that torrent."))
            }
            var info = try await waitForFiles(token: token, id: id)
            let status = JSONValue.string(info["status"]) ?? ""
            if status.range(of: "magnet_error|error|dead|virus", options: .regularExpression) != nil {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "Real-Debrid couldn't open that torrent."))
            }
            guard let file = StreamLogic.pickTorrentFile(files(from: info), fileIndex: fileIndex, episode: episode, season: season) else {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "Couldn't find this episode inside that release."))
            }
            let already = file.selected && !(links(from: info).isEmpty)
            if !already {
                do {
                    _ = try await request(token: token, method: "POST", path: "/torrents/selectFiles/" + id, params: ["files": String(file.id)])
                } catch let error as RDError {
                    if error.code != 31 { return .failure(asFailure(error)) }
                }
                info = try await waitForFiles(token: token, id: id)
            }
            let ready = links(from: info)
            let st = JSONValue.string(info["status"]) ?? ""
            if !st.isEmpty && st != "downloaded" && ready.isEmpty {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "That release isn't cached on Real-Debrid yet. Choose a source with a lightning bolt."))
            }
            guard let link = selectedLink(info: info, file: file), let linkURL = URL(string: link) else {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "Real-Debrid didn't return a link for that file."))
            }
            _ = linkURL
            let unrestricted = try await request(token: token, method: "POST", path: "/unrestrict/link", params: ["link": link])
            if let err = JSONValue.string(unrestricted["error"]) {
                let code = JSONValue.int(unrestricted["error_code"]) ?? 0
                return .failure(PlaybackFailure(kind: .realDebrid, message: StreamLogic.friendlyDebrid(status: 400, code: code, message: err)))
            }
            guard let download = JSONValue.string(unrestricted["download"]), let url = URL(string: download) else {
                return .failure(PlaybackFailure(kind: .realDebrid, message: "Real-Debrid didn't return a playable stream."))
            }
            return .play(url, treatShortAsError: false)
        } catch let error as RDError {
            return .failure(asFailure(error))
        } catch {
            return .failure(PlaybackFailure(kind: .realDebrid, message: "Real-Debrid didn't return a playable stream."))
        }
    }

    private struct RDError: Error {
        var status: Int
        var code: Int
        var message: String
    }

    private static func asFailure(_ error: RDError) -> PlaybackFailure {
        PlaybackFailure(kind: .realDebrid, message: StreamLogic.friendlyDebrid(status: error.status, code: error.code, message: error.message))
    }

    private static func waitForFiles(token: String, id: String) async throws -> [String: Any] {
        var info = try await request(token: token, method: "GET", path: "/torrents/info/" + id, params: nil)
        for _ in 0..<6 {
            let files = files(from: info)
            let st = JSONValue.string(info["status"]) ?? ""
            if !files.isEmpty && (st == "waiting_files_selection" || st == "downloaded" || st == "downloading" || !links(from: info).isEmpty) {
                return info
            }
            if st.range(of: "magnet_error|error|dead", options: .regularExpression) != nil { return info }
            try? await Task.sleep(nanoseconds: 700_000_000)
            info = try await request(token: token, method: "GET", path: "/torrents/info/" + id, params: nil)
        }
        return info
    }

    private static func files(from info: [String: Any]) -> [StreamLogic.TorrentFile] {
        let raw = info["files"] as? [Any] ?? []
        return raw.compactMap { item in
            guard let dict = item as? [String: Any], let id = JSONValue.int(dict["id"]) else { return nil }
            let path = JSONValue.string(dict["path"]) ?? JSONValue.string(dict["name"]) ?? ""
            return StreamLogic.TorrentFile(
                id: id,
                path: path,
                bytes: JSONValue.int(dict["bytes"]) ?? 0,
                selected: JSONValue.int(dict["selected"]) == 1
            )
        }
    }

    private static func links(from info: [String: Any]) -> [String] {
        (info["links"] as? [Any])?.compactMap { JSONValue.string($0) } ?? []
    }

    private static func selectedLink(info: [String: Any], file: StreamLogic.TorrentFile) -> String? {
        let all = links(from: info)
        let selected = files(from: info).filter(\.selected)
        if !selected.isEmpty {
            if let idx = selected.firstIndex(where: { $0.id == file.id }), idx < all.count { return all[idx] }
        }
        return all.count == 1 ? all[0] : nil
    }

    private static func request(token: String, method: String, path: String, params: [String: String]?) async throws -> [String: Any] {
        let url = URL(string: "https://api.real-debrid.com/rest/1.0" + path)!
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 25
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let params, method != "GET" {
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            var components = URLComponents()
            components.queryItems = params.map { URLQueryItem(name: $0.key, value: $0.value) }
            request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if !(200..<300).contains(status) {
            let message = JSONValue.string(obj["error"]) ?? "Real-Debrid HTTP \(status)"
            throw RDError(status: status, code: JSONValue.int(obj["error_code"]) ?? 0, message: message)
        }
        return obj
    }
}
