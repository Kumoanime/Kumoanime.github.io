import Foundation

/// Follows a Comet or Real-Debrid link on the phone and stops if it lands on an
/// ElfHosted error slate or a Real-Debrid error. The final file URL is what VLC plays,
/// so the request that unlocks the link is made from this device.
enum RedirectResolver {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

    static func resolve(original: URL, debrid: Bool) async -> StreamLogic.ResolveOutcome {
        if let title = StreamLogic.slateTitle(from: original) {
            return .failure(PlaybackFailure(kind: .slate, message: title))
        }
        let task = RedirectTask()
        return await task.run(original: original, debrid: debrid)
    }
}

private final class RedirectTask: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private var continuation: CheckedContinuation<StreamLogic.ResolveOutcome, Never>?
    private var resumed = false
    private let lock = NSLock()
    private var session: URLSession?
    private var hops: [URL] = []
    private var slate: String?
    private var response: HTTPURLResponse?
    private var body = Data()
    private var original = URL(string: "https://invalid")!
    private var debrid = false
    private let maxBody = 8192

    func run(original: URL, debrid: Bool) async -> StreamLogic.ResolveOutcome {
        self.original = original
        self.debrid = debrid
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 22
            config.timeoutIntervalForResource = 30
            config.httpCookieAcceptPolicy = .always
            config.httpShouldSetCookies = true
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session
            var request = URLRequest(url: original)
            request.timeoutInterval = 22
            request.setValue("bytes=0-2047", forHTTPHeaderField: "Range")
            request.setValue(RedirectResolver.userAgent, forHTTPHeaderField: "User-Agent")
            request.setValue("*/*", forHTTPHeaderField: "Accept")
            session.dataTask(with: request).resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let next = request.url else {
            completionHandler(request)
            return
        }
        hops.append(next)
        if hops.count > 8 {
            finish(.failure(PlaybackFailure(kind: .http, message: "The source redirected too many times.")))
            completionHandler(nil)
            return
        }
        if let title = StreamLogic.slateTitle(from: next) {
            slate = title
            finish(.failure(PlaybackFailure(kind: .slate, message: title)))
            completionHandler(nil)
            return
        }
        var follow = request
        follow.setValue("bytes=0-2047", forHTTPHeaderField: "Range")
        follow.setValue(RedirectResolver.userAgent, forHTTPHeaderField: "User-Agent")
        completionHandler(follow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        self.response = http
        if let slate {
            finish(.failure(PlaybackFailure(kind: .slate, message: slate)))
            completionHandler(.cancel)
            return
        }
        if let http, let location = http.value(forHTTPHeaderField: "Location"),
           let url = URL(string: location, relativeTo: http.url)?.absoluteURL,
           let title = StreamLogic.slateTitle(from: url) {
            finish(.failure(PlaybackFailure(kind: .slate, message: title)))
            completionHandler(.cancel)
            return
        }
        let snap = snapshot(body: "")
        let decision = StreamLogic.classify(snap)
        if case .play = decision, !needsBody(snap) {
            finish(decision)
            completionHandler(.cancel)
            return
        }
        if case .failure(let failure) = decision, failure.kind == .slate || failure.kind == .realDebrid {
            finish(decision)
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard body.count < maxBody else { return }
        let room = maxBody - body.count
        body.append(data.prefix(room))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let slate {
            finish(.failure(PlaybackFailure(kind: .slate, message: slate)))
            return
        }
        if let error = error as NSError?, error.code == NSURLErrorCancelled {
            finish(.failure(PlaybackFailure(kind: .other, message: "The source didn't respond.")))
            return
        }
        if error != nil && response == nil {
            finish(.failure(PlaybackFailure(kind: .other, message: "The source didn't respond.")))
            return
        }
        let text = String(data: body, encoding: .utf8) ?? ""
        finish(StreamLogic.classify(snapshot(body: text)))
    }

    private func needsBody(_ snap: StreamLogic.ResolveSnapshot) -> Bool {
        let type = snap.contentType.lowercased()
        if snap.status >= 400 { return true }
        if type.contains("json") || type.contains("html") || type.hasPrefix("text/") { return true }
        if snap.complete, let n = snap.totalBytes, n < 6_000_000, snap.debridResolver { return true }
        return false
    }

    private func snapshot(body: String) -> StreamLogic.ResolveSnapshot {
        let http = response
        var headers: [String: String] = [:]
        if let http {
            for (key, value) in http.allHeaderFields {
                guard let name = key as? String else { continue }
                headers[name] = String(describing: value)
            }
        }
        let status = http?.statusCode ?? 0
        let length = StreamLogic.totalLength(status: status, headers: headers)
        let final = http?.url ?? hops.last ?? original
        return StreamLogic.ResolveSnapshot(
            original: original,
            hops: hops,
            finalURL: final,
            status: status,
            contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "",
            totalBytes: length.bytes,
            complete: length.complete,
            body: body,
            debridResolver: debrid || StreamLogic.isDebridResolver(original.absoluteString)
        )
    }

    private func finish(_ outcome: StreamLogic.ResolveOutcome) {
        lock.lock()
        let continuation = self.continuation
        if resumed || continuation == nil {
            lock.unlock()
            return
        }
        resumed = true
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: outcome)
        session?.invalidateAndCancel()
    }
}
