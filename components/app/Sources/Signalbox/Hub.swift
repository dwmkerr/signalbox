import AppKit
import ServiceManagement

// Resolving the signalbox CLI, shared by the hub supervisor and the app's
// jump/hide/remove actions.
enum SignalboxCLI {
    // SIGNALBOX_BIN beats everything (an explicit override), then the copy
    // this bundle ships (guaranteed version-matched with the app), then PATH,
    // then the well-known install dirs - Finder-launched apps get a minimal
    // PATH that misses Homebrew and user installs.
    static func resolve() -> String? {
        let env = ProcessInfo.processInfo.environment
        let fm = FileManager.default
        if let explicit = env["SIGNALBOX_BIN"], !explicit.isEmpty, fm.isExecutableFile(atPath: explicit) {
            return explicit
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("signalbox").path,
           fm.isExecutableFile(atPath: bundled) {
            return bundled
        }
        for dir in (env["PATH"] ?? "").split(separator: ":") {
            let candidate = "\(dir)/signalbox"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        let home = fm.homeDirectoryForCurrentUser.path
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin"] {
            let candidate = "\(dir)/signalbox"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

// The app owns the hub: on launch it starts `signalbox hub` as a child process
// and keeps it alive, so installing the app is installing the product - no
// LaunchAgent, no service to manage. Quit the app and the hub goes with it
// (events fired meanwhile spool on disk and drain on the next delivery); the
// login item brings both back at login.
@MainActor
final class HubSupervisor {
    private var child: Process?
    private var task: Task<Void, Never>?
    private let hubURL: URL

    private static let logTimestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    init(hubURL: URL) {
        self.hubURL = hubURL
    }

    func start() {
        registerLoginItem()
        task = Task { await supervise() }
    }

    func stop() {
        task?.cancel()
        task = nil
        if let child, child.isRunning { child.terminate() }
        child = nil
    }

    // Restart the hub so a fresh process re-reads settings.json - used when
    // Connect Phone or Settings allows other devices (hub.bind = "0.0.0.0" + an
    // auto-generated token). Waits for the old child to release the port before
    // respawning, because terminate() is asynchronous and the new bind would
    // otherwise race the dying process for the port.
    func restart() async {
        let old = child
        child = nil
        old?.terminate()
        for _ in 0..<50 {
            if old?.isRunning != true { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await ensureRunning()
    }

    // The check-spawn loop doubles as the respawn throttle: a crashing hub
    // gets at most one launch per tick, and the app stays responsive because
    // nothing here blocks.
    private func supervise() async {
        while !Task.isCancelled {
            await ensureRunning()
            try? await Task.sleep(nanoseconds: 10_000_000_000)
        }
    }

    private func ensureRunning() async {
        if let child, child.isRunning { return }
        // A hub that already answers is respected, never duplicated - a dev
        // `make hub` in the foreground, or another process on the port.
        if await hubResponds() { return }
        // A remote SIGNALBOX_URL means someone else runs the hub; spawning a
        // local one would just serve a board nobody is looking at.
        guard let port = loopbackPort() else { return }
        spawn(port: port)
    }

    private func hubResponds() async -> Bool {
        var request = HubAuth.request(hubURL.appendingPathComponent("state"))
        request.timeoutInterval = 1
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    // The port to serve on, from the same SIGNALBOX_URL the app reads - nil
    // when the URL points off-machine.
    private func loopbackPort() -> Int? {
        let host = hubURL.host ?? ""
        guard ["127.0.0.1", "localhost", "::1"].contains(host) else { return nil }
        return hubURL.port ?? 8377
    }

    private func spawn(port: Int) {
        let log = logHandle()
        guard let binary = SignalboxCLI.resolve() else {
            recordLifecycle(
                "Signalbox: cannot start the hub - signalbox binary not found",
                in: log
            )
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["hub", "--port", String(port)]
        process.standardOutput = log ?? FileHandle.nullDevice
        process.standardError = log ?? FileHandle.nullDevice
        do {
            try process.run()
            child = process
            recordLifecycle(
                "Signalbox: started hub (pid \(process.processIdentifier), port \(port))",
                in: log
            )
        } catch {
            recordLifecycle("Signalbox: failed to start hub: \(error)", in: log)
        }
    }

    // A restart is exactly when someone opens the Logs tab, so supervisor
    // messages must stay beside child output instead of making hub.log silent.
    private func recordLifecycle(_ message: String, in handle: FileHandle?) {
        NSLog("%@", message)
        let line = "\(Self.logTimestampFormatter.string(from: Date())) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        try? handle?.write(contentsOf: data)
    }

    // Hub output lands in the state dir next to the data it describes, so
    // "why is my board empty" has one place to look.
    private func logHandle() -> FileHandle? {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state/signalbox")
        let path = dir.appendingPathComponent("hub.log").path
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    // Register once, and only for a real install - a dev build run from the
    // repo must not become the login item. Removing it later in System
    // Settings is respected: the one-shot flag stops us re-adding it on every
    // launch.
    private func registerLoginItem() {
        let key = "didRegisterLoginItem"
        guard Bundle.main.bundlePath.hasPrefix("/Applications/"),
              !UserDefaults.standard.bool(forKey: key) else { return }
        try? SMAppService.mainApp.register()
        UserDefaults.standard.set(true, forKey: key)
    }
}
