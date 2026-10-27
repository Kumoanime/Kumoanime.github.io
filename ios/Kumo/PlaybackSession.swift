import UIKit

/// Plays one source. A tap stays on that source. Automatic play may try the next
/// cached source a single time, then stops. It never walks the list again.
@MainActor
final class PlaybackSession: ObservableObject {
    enum Phase: Equatable {
        case idle, resolving, playing, failed
    }

    @Published var selectedIndex: Int?
    @Published var pinned = false
    @Published var status = ""
    @Published var phase: Phase = .idle
    @Published var request: PlayRequest?
    @Published var failure: PlaybackFailure?
    @Published var youtubeID: String?
    @Published var showsPlayer = false

    private var generation = 0
    private var attempts = 0
    private var tried: [Int] = []
    private var order: [StreamRow] = []
    private var explicit = false
    private(set) var context: WatchContext?
    private weak var model: AppModel?

    var hasNext: Bool { context?.hasNext == true }
    var nextTitle: String { context?.nextLabel ?? "Next episode" }
    var nextAccessibility: String { "Next, \(nextTitle)" }
    var contextLabel: String { context?.label ?? "Kumo" }
    var progressContext: WatchContext? { context }

    func bind(_ model: AppModel) {
        self.model = model
    }

    func stop() {
        generation += 1
        request = nil
        phase = .idle
        status = ""
        showsPlayer = false
    }

    func playTapped(rows: [StreamRow], index: Int, context: WatchContext) {
        pinned = true
        selectedIndex = index
        begin(rows: rows, context: context, explicitIndex: index)
    }

    func playAuto(rows: [StreamRow], context: WatchContext) {
        pinned = false
        begin(rows: rows, context: context, explicitIndex: nil)
    }

    func notePlayerFailure(message: String, kind: PlaybackFailure.Kind) {
        let failure = PlaybackFailure(kind: kind, message: message)
        let gen = generation
        Task { await fallback(failure, gen: gen) }
    }

    func notePlayerStarted() {
        phase = .playing
        failure = nil
        status = ""
    }

    private func begin(rows: [StreamRow], context: WatchContext, explicitIndex: Int?) {
        generation += 1
        let gen = generation
        self.context = context
        attempts = 0
        tried = []
        failure = nil
        youtubeID = nil
        request = nil
        explicit = explicitIndex != nil
        if let explicitIndex {
            order = StreamLogic.playbackOrder(rows, start: explicitIndex, explicit: true, skipUncached: false)
        } else {
            order = StreamLogic.autoCandidates(rows)
        }
        guard let first = order.first else {
            status = rows.isEmpty ? "No sources found." : "Pick a source below."
            phase = .failed
            showsPlayer = false
            return
        }
        if !pinned { selectedIndex = first.index }
        showsPlayer = true
        Task { await attempt(first, gen: gen) }
    }

    private func attempt(_ row: StreamRow, gen: Int) async {
        guard gen == generation else { return }
        if !pinned { selectedIndex = row.index }
        tried.append(row.index)
        attempts += 1
        phase = .resolving
        status = attempts > 1 ? "That source didn't play. Trying the next cached source…" : (StreamLogic.isDebridStream(row.stream) ? "Opening source…" : "Opening source…")
        let prepared = await prepare(row)
        guard gen == generation else { return }
        switch prepared {
        case .play(let url, let treatShort):
            let subs = await model?.subtitleURLs(ids: context?.subIDs ?? [], type: context?.subType ?? "series", stream: row.stream) ?? []
            guard gen == generation else { return }
            let resume = context.flatMap { ctx -> Double? in
                guard let episode = ctx.episode else { return nil }
                return model?.resumeTime(route: ctx.route, episode: episode)
            }
            request = PlayRequest(
                token: UUID(),
                url: url,
                resume: resume,
                subtitles: subs,
                treatShortAsError: treatShort,
                label: context?.label ?? row.addonName
            )
            phase = .playing
            status = ""
            showsPlayer = true
        case .youtube(let id):
            youtubeID = id
            phase = .playing
            status = ""
            showsPlayer = true
        case .external(let url):
            phase = .idle
            status = ""
            showsPlayer = false
            await UIApplication.shared.open(url)
        case .failure(let failure):
            await fallback(failure, gen: gen)
        }
    }

    private func fallback(_ failure: PlaybackFailure, gen: Int) async {
        guard gen == generation else { return }
        let allowed = !explicit && attempts < 2 && (failure.kind == .slate || failure.kind == .realDebrid || failure.kind == .statusClip || failure.kind == .player || failure.kind == .http)
        if allowed, let current = tried.last,
           let next = order.drop(while: { $0.index != current }).dropFirst().first(where: { StreamLogic.isCached($0.stream) && !tried.contains($0.index) }) {
            request = nil
            self.failure = nil
            status = "That source didn't play. Trying the next cached source…"
            await attempt(next, gen: gen)
            return
        }
        request = nil
        self.failure = failure
        phase = .failed
        status = ""
        showsPlayer = true
    }

    private enum Prepared {
        case play(URL, Bool)
        case youtube(String)
        case external(URL)
        case failure(PlaybackFailure)
    }

    private func prepare(_ row: StreamRow) async -> Prepared {
        let stream = row.stream
        if let yt = stream.ytId?.nilIfEmpty, stream.url?.nilIfEmpty == nil {
            return .youtube(yt)
        }
        if let external = stream.externalUrl?.nilIfEmpty, stream.url?.nilIfEmpty == nil, let url = URL(string: external) {
            return .external(url)
        }
        if let raw = stream.url?.nilIfEmpty, let url = URL(string: raw) {
            let debrid = StreamLogic.isDebridStream(stream) || StreamLogic.isDebridResolver(raw)
            let outcome = await RedirectResolver.resolve(original: url, debrid: debrid)
            switch outcome {
            case .play(let final, let treatShort):
                return .play(final, treatShort)
            case .failure(let failure):
                return .failure(failure)
            }
        }
        let hash = StreamLogic.hash(of: stream)
        if !hash.isEmpty, let token = model?.effectiveToken() {
            let parts = StreamLogic.playbackParts(stream.url)
            let outcome = await RealDebridClient.resolveOriginal(
                hash: hash,
                fileIndex: parts?.fileIndex,
                season: parts?.season,
                episode: parts?.episode ?? context?.episode,
                token: token
            )
            switch outcome {
            case .play(let url, let treatShort):
                return .play(url, treatShort)
            case .failure(let failure):
                return .failure(failure)
            }
        }
        if stream.infoHash?.isEmpty == false {
            return .failure(PlaybackFailure(kind: .other, message: "This source is a torrent. Add a Real-Debrid token under Add-ons, or pick a source with a link."))
        }
        return .failure(PlaybackFailure(kind: .other, message: "This source has no playable link."))
    }
}
