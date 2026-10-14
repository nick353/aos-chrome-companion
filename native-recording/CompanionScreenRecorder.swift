import AVFoundation
import AppKit
import CoreMedia
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

private final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func request() { lock.lock(); value = true; lock.unlock() }
    func requested() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

@available(macOS 15.0, *)
private final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var started = false
    private var finished = false
    private var failure: Error?

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        lock.lock(); started = true; lock.unlock()
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: any Error) {
        lock.lock(); failure = error; finished = true; lock.unlock()
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        lock.lock(); finished = true; lock.unlock()
    }

    func state() -> (started: Bool, finished: Bool, failure: Error?) {
        lock.lock(); defer { lock.unlock() }
        return (started, finished, failure)
    }
}

private enum RecorderError: Error, CustomStringConvertible {
    case invalidArguments
    case chromeNotFrontmost
    case chromeWindowNotFound
    case permissionOrContentUnavailable
    case failed(String)
    var description: String {
        switch self {
        case .invalidArguments: return "native_recording_invalid_arguments"
        case .chromeNotFrontmost: return "native_recording_chrome_not_frontmost"
        case .chromeWindowNotFound: return "native_recording_chrome_window_not_found"
        case .permissionOrContentUnavailable: return "native_recording_screen_recording_permission_required"
        case .failed(let value): return "native_recording_failed_\(value)"
        }
    }
}

private struct Arguments {
    let output: URL
    static func parse(_ raw: [String]) throws -> Arguments {
        guard raw.count == 2, raw[0] == "--output" else { throw RecorderError.invalidArguments }
        let output = URL(fileURLWithPath: raw[1]).standardizedFileURL
        guard !FileManager.default.fileExists(atPath: output.path) else { throw RecorderError.failed("output_exists") }
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        return Arguments(output: output)
    }
}

private func frontmostChromeWindow() throws -> (CGWindowID, pid_t) {
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
          frontmost.bundleIdentifier == "com.google.Chrome" else {
        throw RecorderError.chromeNotFrontmost
    }
    let chromePID = frontmost.processIdentifier
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        throw RecorderError.chromeWindowNotFound
    }
    // CGWindowListCopyWindowInfo is front-to-back. Use the foremost normal
    // window of the frontmost Chrome process; never guess by window size or
    // silently capture a different Chrome window/profile.
    for item in raw {
        guard let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              owner == chromePID,
              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
              let id = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        return (id, owner)
    }
    throw RecorderError.chromeWindowNotFound
}

private func inspectFinalizedMedia(at url: URL) async throws -> (videoFrames: Int, audioSamples: Int, durationSeconds: Double) {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.load(.tracks)
    guard let video = tracks.first(where: { $0.mediaType == .video }),
          let audio = tracks.first(where: { $0.mediaType == .audio }) else {
        throw RecorderError.failed("final_media_missing_video_or_audio_track")
    }
    let durationValue = try await asset.load(.duration)
    let duration = durationValue.seconds
    guard duration.isFinite, duration > 0 else { throw RecorderError.failed("final_media_duration_invalid") }

    let reader = try AVAssetReader(asset: asset)
    let videoOutput = AVAssetReaderTrackOutput(track: video, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
    ])
    let audioOutput = AVAssetReaderTrackOutput(track: audio, outputSettings: nil)
    guard reader.canAdd(videoOutput), reader.canAdd(audioOutput) else {
        throw RecorderError.failed("final_media_reader_configuration_failed")
    }
    reader.add(videoOutput)
    reader.add(audioOutput)
    guard reader.startReading() else { throw RecorderError.failed("final_media_reader_start_failed") }
    var videoFrames = 0
    var audioSamples = 0
    while videoFrames < 2 || audioSamples == 0 {
        if videoFrames < 2, let sample = videoOutput.copyNextSampleBuffer() {
            videoFrames += max(0, CMSampleBufferGetNumSamples(sample))
        }
        if audioSamples == 0, let sample = audioOutput.copyNextSampleBuffer() {
            audioSamples += max(0, CMSampleBufferGetNumSamples(sample))
        }
        if reader.status == .failed { throw RecorderError.failed("final_media_reader_failed") }
        if reader.status == .completed || (videoFrames == 0 && audioSamples == 0) { break }
    }
    reader.cancelReading()
    guard videoFrames >= 2, audioSamples > 0 else {
        throw RecorderError.failed("final_media_has_no_verified_audio_samples_or_video_frames")
    }
    return (videoFrames, audioSamples, duration)
}

@available(macOS 15.0, *)
@main
private struct CompanionScreenRecorder {
    @MainActor static func main() async {
        do {
            _ = NSApplication.shared
            NSApplication.shared.setActivationPolicy(.prohibited)
            let arguments = try Arguments.parse(Array(CommandLine.arguments.dropFirst()))
            let (windowID, ownerPID) = try frontmostChromeWindow()
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == ownerPID }) else {
                throw RecorderError.permissionOrContentUnavailable
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(max(1.0, filter.pointPixelScale))
            let configuration = SCStreamConfiguration()
            configuration.width = max(2, Int(window.frame.width * scale) / 2 * 2)
            configuration.height = max(2, Int(window.frame.height * scale) / 2 * 2)
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            configuration.queueDepth = 8
            configuration.pixelFormat = kCVPixelFormatType_32BGRA
            configuration.showsCursor = true
            configuration.capturesAudio = true
            configuration.sampleRate = 48000
            configuration.channelCount = 2
            configuration.ignoreGlobalClipSingleWindow = true
            let recordingConfiguration = SCRecordingOutputConfiguration()
            recordingConfiguration.outputURL = arguments.output
            recordingConfiguration.outputFileType = .mov
            recordingConfiguration.videoCodecType = .h264
            // Keep the delegate strongly owned for the whole capture. The
            // output delegate is allowed to be weak by the framework, and a
            // transient delegate can make video completion/flush unreliable.
            let delegate = RecordingDelegate()
            let recordingOutput = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
            let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            try stream.addRecordingOutput(recordingOutput)
            try await stream.startCapture()
            for _ in 0..<50 {
                let state = delegate.state()
                if let failure = state.failure { throw RecorderError.failed("output_\(failure.localizedDescription)") }
                if state.started { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard delegate.state().started else { throw RecorderError.failed("output_start_timeout") }
            let stop = StopSignal()
            FileHandle.standardInput.readabilityHandler = { handle in
                _ = try? handle.read(upToCount: 4096)
                stop.request()
            }
            FileHandle.standardOutput.write(Data("native_recording_started window_id=\(windowID) target=frontmost_chrome_window audio_requested=1\n".utf8))
            while !stop.requested() { try await Task.sleep(nanoseconds: 100_000_000) }
            FileHandle.standardInput.readabilityHandler = nil
            try stream.removeRecordingOutput(recordingOutput)
            for _ in 0..<50 {
                let state = delegate.state()
                if let failure = state.failure { throw RecorderError.failed("output_\(failure.localizedDescription)") }
                if state.finished { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard delegate.state().finished else { throw RecorderError.failed("output_finish_timeout") }
            try await stream.stopCapture()
            let media = try await inspectFinalizedMedia(at: arguments.output)
            FileHandle.standardOutput.write(Data("native_recording_stopped window_id=\(windowID) audio_track=1 audio_samples=\(media.audioSamples) video_frames=\(media.videoFrames) duration_seconds=\(media.durationSeconds) bytes=\(recordingOutput.recordedFileSize)\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
