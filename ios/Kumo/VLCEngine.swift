import AVFoundation
import SwiftUI
import UIKit
import MobileVLCKit

struct MediaTrack: Identifiable, Equatable {
    var id: Int
    var name: String
}

/// Wraps MobileVLCKit. The view assigns a UIView as the drawable; VLC decodes
/// MKV, HEVC, and AC3 itself and follows the final file URL we already resolved.
final class VLCEngine: NSObject, ObservableObject, VLCMediaPlayerDelegate {
    @Published var isPlaying = false
    @Published var seconds: Double = 0
    @Published var duration: Double = 0
    @Published var audioTracks: [MediaTrack] = []
    @Published var subtitleTracks: [MediaTrack] = []
    @Published var currentAudioID: Int = -1
    @Published var currentSubtitleID: Int = -1
    @Published var buffering = false

    let player = VLCMediaPlayer()
    var onFailure: ((String, PlaybackFailure.Kind) -> Void)?
    var onEnded: (() -> Void)?
    var preferredSubtitle = ""

    private var accepting = false
    private var didReport = false
    private var appliedSubtitle = false
    private var appliedResume = false
    private var treatShortAsError = false
    private var resumeAt: Double?
    private var stall: DispatchWorkItem?
    private weak var drawable: UIView?

    override init() {
        super.init()
        player.delegate = self
    }

    func attach(_ view: UIView) {
        drawable = view
        player.drawable = view
    }

    func play(_ request: PlayRequest, rate: Float) {
        stopInternal(report: false)
        accepting = true
        didReport = false
        appliedSubtitle = false
        appliedResume = false
        treatShortAsError = request.treatShortAsError
        resumeAt = request.resume
        seconds = 0
        duration = 0
        buffering = true
        isPlaying = false

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        let media = VLCMedia(url: request.url)
        media.addOption(":network-caching=3000")
        media.addOption(":file-caching=3000")
        media.addOption(":http-reconnect")
        media.addOption(":http-user-agent=\(RedirectResolver.userAgent)")
        if let view = drawable { player.drawable = view }
        player.media = media
        for subtitle in request.subtitles {
            player.addPlaybackSlave(subtitle, type: .subtitle, enforce: false)
        }
        player.rate = rate
        player.play()
        armStall()
    }

    func toggle() {
        if player.isPlaying { player.pause() } else { player.play() }
    }

    func seek(to seconds: Double) {
        let upper = duration > 1 ? duration - 0.4 : seconds
        let target = min(max(0, seconds), upper)
        player.time = VLCTime(int: Int32(target * 1000))
        self.seconds = target
    }

    func selectAudio(_ id: Int) {
        player.currentAudioTrackIndex = Int32(id)
        currentAudioID = id
    }

    func selectSubtitle(_ id: Int) {
        player.currentVideoSubTitleIndex = Int32(id)
        currentSubtitleID = id
    }

    func setRate(_ rate: Float) {
        player.rate = rate
    }

    func stop() {
        stopInternal(report: false)
    }

    func mediaPlayerStateChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.handleState() }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.handleTime() }
    }

    private func handleState() {
        guard accepting else { return }
        switch player.state {
        case .playing:
            buffering = false
            isPlaying = true
            refreshTracks()
            applyResumeIfNeeded()
            applySubtitleIfNeeded()
            publishTime()
            if treatShortAsError && duration > 1 && duration < 40 {
                fail("The add-on sent an error clip instead of the episode.", kind: .statusClip)
            }
        case .buffering, .opening:
            buffering = true
            isPlaying = player.isPlaying
            refreshTracks()
        case .paused:
            isPlaying = false
            buffering = false
        case .ended:
            isPlaying = false
            buffering = false
            publishTime()
            if treatShortAsError && duration > 0 && duration < 40 {
                fail("The add-on sent an error clip instead of the episode.", kind: .statusClip)
            } else if !didReport {
                onEnded?()
            }
        case .error:
            fail("That source didn't start.", kind: .player)
        default:
            break
        }
    }

    private func handleTime() {
        guard accepting else { return }
        publishTime()
        refreshTracks()
        applyResumeIfNeeded()
        applySubtitleIfNeeded()
        if player.isPlaying {
            buffering = false
            isPlaying = true
        }
        if treatShortAsError && duration > 1 && duration < 40 {
            fail("The add-on sent an error clip instead of the episode.", kind: .statusClip)
        }
    }

    private func publishTime() {
        let now = Double(player.time.intValue) / 1000
        if now >= 0 { seconds = now }
        let length = Double(player.media?.length.intValue ?? 0) / 1000
        if length > 1 {
            duration = length
        } else if player.position > Float(0.02), now > 0 {
            duration = now / Double(player.position)
        }
    }

    private func applyResumeIfNeeded() {
        guard !appliedResume, let resumeAt, resumeAt > 1, duration > 1, resumeAt < duration * 0.92 else { return }
        appliedResume = true
        seek(to: resumeAt)
    }

    private func applySubtitleIfNeeded() {
        guard !appliedSubtitle, !preferredSubtitle.isEmpty else { return }
        guard let match = subtitleTracks.first(where: {
            $0.id >= 0 && ($0.name.caseInsensitiveCompare(preferredSubtitle) == .orderedSame
                || $0.name.localizedCaseInsensitiveContains(preferredSubtitle))
        }) else { return }
        appliedSubtitle = true
        selectSubtitle(match.id)
    }

    private func refreshTracks() {
        let audio = Self.tracks(names: player.audioTrackNames, indexes: player.audioTrackIndexes)
        let subs = Self.tracks(names: player.videoSubTitlesNames, indexes: player.videoSubTitlesIndexes)
        if audio != audioTracks { audioTracks = audio }
        if subs != subtitleTracks { subtitleTracks = subs }
        currentAudioID = Int(player.currentAudioTrackIndex)
        currentSubtitleID = Int(player.currentVideoSubTitleIndex)
    }

    private func armStall() {
        stall?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.accepting, !self.didReport, !self.isPlaying, self.seconds < 1 else { return }
            self.fail("That source didn't start.", kind: .player)
        }
        stall = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 28, execute: work)
    }

    private func fail(_ message: String, kind: PlaybackFailure.Kind) {
        guard accepting, !didReport else { return }
        didReport = true
        accepting = false
        stall?.cancel()
        player.stop()
        onFailure?(message, kind)
    }

    private func stopInternal(report: Bool) {
        accepting = false
        stall?.cancel()
        player.stop()
        isPlaying = false
        buffering = false
        _ = report
    }

    private static func tracks(names: Any?, indexes: Any?) -> [MediaTrack] {
        guard let names = names as? NSArray, let indexes = indexes as? NSArray else { return [] }
        let count = min(names.count, indexes.count)
        var result: [MediaTrack] = []
        for i in 0..<count {
            let name = (names[i] as? String) ?? String(describing: names[i])
            let id: Int
            if let number = indexes[i] as? NSNumber {
                id = number.intValue
            } else if let number = indexes[i] as? Int {
                id = number
            } else {
                continue
            }
            result.append(MediaTrack(id: id, name: name))
        }
        return result
    }
}

struct VLCVideoView: UIViewRepresentable {
    let engine: VLCEngine

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        engine.attach(view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        engine.attach(uiView)
    }
}
