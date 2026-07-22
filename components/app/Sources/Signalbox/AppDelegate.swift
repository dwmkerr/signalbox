import AppKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private struct Session {
        var event: SessionEvent
        var date: Date
        // Engagement-MRU sort key per contract; hub-provided engaged_ts wins,
        // else tracked locally so ordering survives between /state resyncs.
        var engagedDate: Date
        var acked: Bool
        // Contract: hidden suppresses the row until its next agent event;
        // acked only clears the flag - the row stays visible.
        var hidden: Bool
        // Carried across events that omit them, mirroring the hub's merge
        // rule ("detail, reply and origin persist; latest wins only when
        // non-empty") so SSE-applied raw events do not blank the breadcrumb
        // or the preview's exchange.
        var detail: String?
        var reply: String?
        var origin: SessionOrigin?
        // The user's own display label ("label" user-event); beats the agent
        // title. Carried across agent events; only a label event changes it.
        var label: String?
        // Discreet tags carried across agent events; only tag/untag change them.
        // Drive `#tag` search in the palette.
        var tags: [String]?
        // User pin, carried across agent events (pins survive agent activity);
        // only pin/unpin change it. Drives the pin mark and the reposition
        // partition - pinned rows sort first, mirroring the hub's order.
        var pinned: Bool
        // Tracked locally so a `done` after a long `busy` can earn a notification.
        var busySince: Date?
    }

    private let hubURL: URL = {
        let raw = ProcessInfo.processInfo.environment["SIGNALBOX_URL"] ?? "http://127.0.0.1:8377"
        return URL(string: raw) ?? URL(string: "http://127.0.0.1:8377")!
    }()

    private let urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        // The stream idles between events; the hub's 15s heartbeat keeps it under
        // this limit, while a connection killed by sleep errors out within 90s.
        config.timeoutIntervalForRequest = 90
        return URLSession(configuration: config)
    }()

    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var sessions: [String: Session] = [:]
    // Hub-authoritative display order: /state order is adopted verbatim, and
    // SSE updates reposition single keys instead of re-sorting the whole list,
    // so the app can never disagree with the hub's engagement-MRU ordering.
    private var order: [String] = []
    private var lastSeq = 0
    private var streamTask: Task<Void, Never>?
    // Suppresses notifications for state that existed before the app started.
    private var didInitialLoad = false
    private var notificationsAvailable = false
    // Retained so Foundation reaps the children; pruned on the next spawn.
    private var runningProcesses: [Process] = []
    private var hotkey: GlobalHotkey?
    private var palette: PaletteController?
    private var settings: SettingsController?
    private var connectPhone: ConnectPhoneController?
    // Additional filters (Settings): when set, every surface - the jumplist and
    // the menu bar list - shows only sessions carrying these tags. Persisted so
    // it survives restarts, the quiet way to flip the board to `demo` for a
    // recording and back. Set in Settings or via the `--filter` launch arg.
    private let tagFilterKey = "tagFilter"
    // Without the CLI, jump/hide/remove silently no-op - surface that in the
    // menu (and once as a notification) instead of only NSLog.
    private var cliMissing = false
    // The app owns the hub: started here, killed on quit (see Hub.swift).
    private var hubSupervisor: HubSupervisor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // Newest instance wins: launching a rebuilt bundle (or the installed
        // copy over a dev build) quits any older instance instead of running
        // two menu bar icons that fight over hub ownership. The old app takes
        // its hub child down on terminate; our supervisor respawns within its
        // tick, and the board state survives in the event log.
        let others = NSRunningApplication.runningApplications(
            withBundleIdentifier: Bundle.main.bundleIdentifier ?? ""
        ).filter { $0 != NSRunningApplication.current }
        others.forEach { $0.terminate() }

        applyLaunchFilter()

        // Start the hub before the stream connects - the stream loop's
        // backoff absorbs the moment it takes to come up.
        hubSupervisor = HubSupervisor(hubURL: hubURL)
        hubSupervisor?.start()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = statusItemImage(style: .current, dot: nil)
            button.imagePosition = .imageOnly
        }
        statusItem.menu = menu
        menu.delegate = self
        rebuildMenu()

        settings = SettingsController(
            hubURL: hubURL,
            onIconChange: { [weak self] in self?.updateStatusIcon() },
            onFilterChange: { [weak self] in self?.refreshUI() },
            restartHub: { [weak self] in await self?.hubSupervisor?.restart() }
        )
        connectPhone = ConnectPhoneController(
            hubURL: hubURL,
            restartHub: { [weak self] in await self?.hubSupervisor?.restart() }
        )
        setupNotifications()
        setupPalette()

        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(didWake(_:)),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )

        restartStream()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // One lifecycle: quitting the app takes the hub down with it. Events
        // fired while it is gone spool and drain on the next delivery.
        hubSupervisor?.stop()
    }

    @objc private func didWake(_ note: Notification) {
        // The pre-sleep TCP connection is usually dead; reconnect immediately
        // instead of waiting for the idle timeout to notice.
        restartStream()
    }

    // MARK: - Hub data

    private func restartStream() {
        streamTask?.cancel()
        streamTask = Task { await self.runStreamLoop() }
    }

    private func runStreamLoop() async {
        var backoffSeconds: UInt64 = 1
        while !Task.isCancelled {
            do {
                // Full /state resync on every (re)connect covers events missed
                // while disconnected without relying solely on stream replay.
                try await syncState()
                backoffSeconds = 1
                try await consumeStream()
            } catch is CancellationError {
                return
            } catch {
                // Hub down or connection dropped - retry below.
            }
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
            backoffSeconds = min(backoffSeconds * 2, 15)
        }
    }

    private func syncState() async throws {
        let url = hubURL.appendingPathComponent("state")
        let (data, response) = try await urlSession.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let decoded = try JSONDecoder().decode(StateResponse.self, from: data)
        applyFullState(decoded.sessions)
    }

    private func consumeStream() async throws {
        guard var components = URLComponents(
            url: hubURL.appendingPathComponent("stream"),
            resolvingAgainstBaseURL: false
        ) else { throw URLError(.badURL) }
        components.queryItems = [URLQueryItem(name: "since", value: String(lastSeq))]
        guard let url = components.url else { throw URLError(.badURL) }

        let (bytes, response) = try await urlSession.bytes(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        // The frame label decides what the next data line means: `signal` is an
        // event to fold in, `command` is a request to act on now. Heartbeat
        // comments (":") carry no payload; the hub sends each JSON on a single
        // data line.
        var frame = "signal"
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                frame = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                continue
            }
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8) else { continue }
            if frame == "command" {
                if let command = try? JSONDecoder().decode(HubCommand.self, from: data) {
                    perform(command)
                }
            } else if let event = try? JSONDecoder().decode(SessionEvent.self, from: data) {
                apply(event)
            }
            // Per SSE, the label applies to one dispatch only - reset so a
            // later data line can never inherit a stale one.
            frame = "signal"
        }
        // Server closed the stream cleanly - treat like a drop so the loop reconnects.
    }

    private func applyFullState(_ events: [SessionEvent]) {
        let old = sessions
        var fresh: [String: Session] = [:]
        var freshOrder: [String] = []
        for event in events {
            let date = EventDate.parse(event.ts) ?? Date()
            let prev = old[event.sessionKey]
            let session = Session(
                event: event,
                date: date,
                // Hub is authoritative when it sends engaged_ts; otherwise keep
                // local engagement knowledge, else first-seen fallback.
                engagedDate: EventDate.parse(event.engagedTs) ?? prev?.engagedDate ?? date,
                acked: event.acked ?? false,
                hidden: event.hidden ?? false,
                detail: firstNonEmpty(event.prompt, prev?.detail),
                reply: firstNonEmpty(event.reply, prev?.reply),
                origin: event.origin ?? prev?.origin,
                // /state rows carry the merged label, absent when cleared -
                // hub-authoritative, no local carry.
                label: event.label,
                // /state carries the merged tag set; hub-authoritative.
                tags: event.tags,
                // /state carries pinned; hub-authoritative, no local carry.
                pinned: event.pinned ?? false,
                busySince: busyStart(for: event, date: date, prev: prev)
            )
            if fresh[event.sessionKey] == nil { freshOrder.append(event.sessionKey) }
            fresh[event.sessionKey] = session
            if let seq = event.seq { lastSeq = max(lastSeq, seq) }
            if didInitialLoad {
                maybeNotify(new: event, date: date, prev: prev, acked: session.acked, hidden: session.hidden)
            }
        }
        sessions = fresh
        order = freshOrder
        didInitialLoad = true
        refreshUI()
    }

    private func apply(_ event: SessionEvent) {
        if let seq = event.seq {
            // Replayed events after reconnect were already folded in via /state.
            guard seq > lastSeq else { return }
            lastSeq = seq
        }
        let key = event.sessionKey
        switch event.event {
        case "ended":
            sessions.removeValue(forKey: key)
            order.removeAll { $0 == key }
        case "seen":
            // User ack, not agent lifecycle: clear the needs-you flag and mark
            // the session most recently engaged. The row stays visible per
            // contract - visiting a session is normal, not dismissal.
            guard var session = sessions[key] else { break }
            session.acked = true
            session.engagedDate = EventDate.parse(event.engagedTs)
                ?? EventDate.parse(event.ts) ?? Date()
            sessions[key] = session
            reposition(key)
        case "label":
            // User rename: display label only - no ack, no engagement bump,
            // no reorder. Absent label (omitempty on empty) clears back to
            // the agent title.
            guard var session = sessions[key] else { break }
            session.label = event.label
            sessions[key] = session
        case "tag", "untag":
            // Discreet tag change: no ack, no engagement bump, no reorder -
            // same lifecycle-neutral treatment as label. The raw event carries
            // only the affected tag; merge it into the known set.
            guard var session = sessions[key], let tag = event.tags?.first else { break }
            var set = session.tags ?? []
            set.removeAll { $0 == tag }
            if event.event == "tag" { set.append(tag) }
            session.tags = set.isEmpty ? nil : set
            sessions[key] = session
        case "pin", "unpin":
            // User pin toggle: flips the flag and repositions immediately so
            // the row jumps into (or out of) the pinned partition without
            // waiting for a /state resync. No ack, no engagement bump -
            // engagement order within each partition is untouched, so the
            // local move lands exactly where the hub's order will.
            guard var session = sessions[key] else { break }
            session.pinned = event.event == "pin"
            sessions[key] = session
            reposition(key)
        case "show":
            // User unhide: clears the flag so the row returns to the main list
            // in place. No ack, no engagement bump, no reorder - handled like the
            // pin toggle, never rebuilt as an agent event.
            guard var session = sessions[key] else { break }
            session.hidden = false
            sessions[key] = session
        case "hide":
            guard var session = sessions[key] else { break }
            if session.event.event == "busy" {
                // Contract: hide on a busy row is treated as seen - a running
                // session must stay visible.
                session.acked = true
                session.engagedDate = EventDate.parse(event.engagedTs)
                    ?? EventDate.parse(event.ts) ?? Date()
                sessions[key] = session
                reposition(key)
            } else {
                // Suppressed until the next agent event resurfaces it (the hub
                // resets hidden then); order is untouched so it reappears in place.
                session.hidden = true
                sessions[key] = session
            }
        default:
            let prev = sessions[key]
            let date = EventDate.parse(event.ts) ?? Date()
            let engaged = engagedDate(for: event, date: date, prev: prev)
            // Any agent event resets acked and hidden unless the payload says
            // otherwise - this is what resurfaces hidden rows and re-arms
            // notifications for previously acked ones.
            let session = Session(
                event: event,
                date: date,
                engagedDate: engaged,
                acked: event.acked ?? false,
                hidden: event.hidden ?? false,
                detail: firstNonEmpty(event.prompt, prev?.detail),
                reply: firstNonEmpty(event.reply, prev?.reply),
                origin: event.origin ?? prev?.origin,
                // SSE broadcasts raw agent events (pre-merge), which never
                // carry a label - keep the one we know.
                label: prev?.label,
                // Same for tags: raw agent events don't carry them, keep known.
                tags: prev?.tags,
                // Pins survive agent activity: raw events omit pinned, so keep
                // the known state rather than clearing it.
                pinned: event.pinned ?? prev?.pinned ?? false,
                busySince: busyStart(for: event, date: date, prev: prev)
            )
            sessions[key] = session
            // Status never reorders (contract): only engagement, or arrival of
            // a brand-new session, moves a row.
            if prev == nil || prev?.engagedDate != engaged { reposition(key) }
            maybeNotify(new: event, date: date, prev: prev, acked: session.acked, hidden: session.hidden)
        }
        refreshUI()
    }

    // Insert the changed session where engagement MRU puts it (engaged_ts
    // descending), leaving every other row exactly where /state placed it.
    // Pinned rows form a top partition (hub contract): an engagement bump on
    // an unpinned row must never carry it above a pinned one, so insertion
    // respects the partition before comparing engagement.
    private func reposition(_ key: String) {
        order.removeAll { $0 == key }
        guard let session = sessions[key] else { return }
        let index = order.firstIndex { otherKey in
            guard let other = sessions[otherKey] else { return false }
            if session.pinned != other.pinned { return session.pinned }
            return other.engagedDate < session.engagedDate
        } ?? order.count
        order.insert(key, at: index)
    }

    // Engagement per contract: hub-provided engaged_ts wins; a busy that is a
    // real prompt (not session_start/retry) counts; otherwise keep what we
    // knew, falling back to first-seen for never-engaged sessions.
    private func engagedDate(for event: SessionEvent, date: Date, prev: Session?) -> Date {
        if let engaged = EventDate.parse(event.engagedTs) { return engaged }
        if event.event == "busy" {
            let reason = event.reason ?? ""
            if reason != "session_start" && reason != "retry" { return date }
        }
        return prev?.engagedDate ?? date
    }

    private func busyStart(for event: SessionEvent, date: Date, prev: Session?) -> Date? {
        guard event.event == "busy" else { return nil }
        // A busy→busy update keeps the original start time.
        if let prev, prev.event.event == "busy", let since = prev.busySince { return since }
        return date
    }

    private func firstNonEmpty(_ values: String?...) -> String? {
        for value in values where value?.isEmpty == false { return value }
        return nil
    }

    // MARK: - Notifications

    private func setupNotifications() {
        // UNUserNotificationCenter raises an Objective-C exception in a process
        // without a bundle identifier (the bare swift-build binary); the full
        // behaviour requires running from the assembled Signalbox.app.
        guard Bundle.main.bundleIdentifier != nil else { return }
        notificationsAvailable = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error { NSLog("Signalbox: notification authorization failed: \(error)") }
        }
    }

    private func maybeNotify(new: SessionEvent, date: Date, prev: Session?, acked: Bool, hidden: Bool) {
        // Acked state is dealt-with and hidden state is dismissed - never ping
        // for either (matters on /state resyncs, where such rows would
        // otherwise look like changes). Both flags are the NEW event's values:
        // the hub resets them on agent events, so a fresh attention/done on a
        // previously acked or hidden session still notifies.
        guard notificationsAvailable, !acked, !hidden, prev?.event.event != new.event else { return }
        let shouldNotify: Bool
        switch new.event {
        case "attention", "error":
            shouldNotify = true
        case "done":
            // Quick prompt turnarounds are noise; only long-running work pings.
            if let prev, prev.event.event == "busy", let since = prev.busySince {
                shouldNotify = date.timeIntervalSince(since) > 30
            } else {
                shouldNotify = false
            }
        default:
            shouldNotify = false
        }
        guard shouldNotify else { return }

        let content = UNMutableNotificationContent()
        let verb: String
        switch new.event {
        case "attention": verb = "needs attention"
        case "error": verb = "hit an error"
        default: verb = "finished"
        }
        content.title = "\(new.agent) \(verb)"
        var body = displayName(for: new, label: sessions[new.sessionKey]?.label)
        if let reason = new.reason, !reason.isEmpty { body += " · \(reason)" }
        content.body = body
        content.sound = .default
        content.userInfo = ["session_key": new.sessionKey]
        // Keyed by session so a newer signal replaces the stale banner.
        let request = UNNotificationRequest(identifier: new.sessionKey, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Palette

    private func setupPalette() {
        palette = PaletteController(
            rowsProvider: { [weak self] in self?.paletteRows() ?? [] },
            onJump: { [weak self] key in self?.jump(to: key) },
            onHide: { [weak self] key in self?.hide(sessionKey: key) },
            onShow: { [weak self] key in self?.show(sessionKey: key) },
            onRemove: { [weak self] key in self?.remove(sessionKey: key) },
            onLabel: { [weak self] key, text in self?.setLabel(sessionKey: key, text: text) },
            onPin: { [weak self] key, pinned in self?.setPinned(sessionKey: key, pinned: pinned) },
            onSettings: { [weak self] in self?.settings?.show() }
        )
        let spec: GlobalHotkey.Spec
        if let raw = UserDefaults.standard.string(forKey: "hotkey"), !raw.isEmpty {
            if let parsed = GlobalHotkey.parse(raw) {
                spec = parsed
            } else {
                NSLog("Signalbox: cannot parse hotkey '\(raw)', using \(GlobalHotkey.defaultSpec.display)")
                spec = GlobalHotkey.defaultSpec
            }
        } else {
            spec = GlobalHotkey.defaultSpec
        }
        hotkey = GlobalHotkey(spec: spec) { [weak self] in self?.palette?.toggle() }
        if hotkey?.register() != true {
            // Another app owns the combo (Carbon is first-come-first-served).
            // A jumplist you cannot summon is a broken app, so fall back to
            // the previous default and say so.
            let fallback = GlobalHotkey.fallbackSpec
            guard spec.display != fallback.display else { return }
            hotkey = GlobalHotkey(spec: fallback) { [weak self] in self?.palette?.toggle() }
            let recovered = hotkey?.register() == true
            NSLog("Signalbox: \(spec.display) is taken by another app; \(recovered ? "using \(fallback.display)" : "no hotkey available")")
            guard notificationsAvailable else { return }
            let content = UNMutableNotificationContent()
            content.title = "Jumplist shortcut unavailable"
            content.body = recovered
                ? "\(spec.display) is taken by another app - using \(fallback.display) instead. Free the combo there or pick another in Settings."
                : "\(spec.display) and \(fallback.display) are both taken by other apps - set one in Settings."
            let request = UNNotificationRequest(
                identifier: "signalbox-hotkey-conflict", content: content, trigger: nil
            )
            UNUserNotificationCenter.current().add(request)
        }
    }

    // Only hidden rows drop out (contract: hide suppresses until the next
    // agent event). Acked rows keep their place - seen clears the flag, never
    // the row - rendered with the same status symbol in neutral gray. Order is
    // the hub's engagement MRU, adopted verbatim - no local grouping.
    // A `--filter <tags>` launch argument sets the additional filters at
    // startup, so you can quit and relaunch straight into a filtered view -
    // e.g. `open Signalbox.app --args --filter demo` restarts in demo mode.
    // `--filter` with no value (or an empty value) clears it back to all.
    private func applyLaunchFilter() {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "--filter") else { return }
        let value = (i + 1 < args.count && !args[i + 1].hasPrefix("--")) ? args[i + 1] : ""
        if value.isEmpty { UserDefaults.standard.removeObject(forKey: tagFilterKey) }
        else { UserDefaults.standard.set(value, forKey: tagFilterKey) }
    }

    // Additional filters, always applied. Same grammar as the jumplist search:
    // `#tag` matches a tag, plain text matches the session name/title/agent/
    // prompt, and a leading `!` excludes either (`!project` hides a project
    // from a recording without tagging anything). Space/comma-separated.
    private struct FilterToken {
        let text: String // lowercased
        let isTag: Bool
        let negate: Bool
    }

    private func activeFilters() -> [FilterToken] {
        var tokens: [FilterToken] = []
        for raw in (UserDefaults.standard.string(forKey: tagFilterKey) ?? "")
            .components(separatedBy: CharacterSet(charactersIn: " ,")) {
            var token = raw.trimmingCharacters(in: .whitespaces)
            let negate = token.hasPrefix("!")
            if negate { token = String(token.dropFirst()) }
            let isTag = token.hasPrefix("#")
            if isTag { token = String(token.dropFirst()) }
            token = token.trimmingCharacters(in: .whitespaces).lowercased()
            guard !token.isEmpty else { continue }
            tokens.append(FilterToken(text: token, isTag: isTag, negate: negate))
        }
        return tokens
    }

    // What plain-text tokens match against: the session's visible identity.
    private func filterHaystack(_ s: Session) -> String {
        var parts = [s.event.agent, displayName(for: s.event, label: s.label)]
        if let title = s.event.title { parts.append(title) }
        if let detail = s.detail { parts.append(detail) }
        return parts.joined(separator: " ").lowercased()
    }

    // A session passes when it matches every include token and no exclude
    // token. No filters = everything passes. Shared by the jumplist and the
    // menu bar list so the two never disagree.
    private func passesFilters(_ session: Session, _ tokens: [FilterToken]) -> Bool {
        guard !tokens.isEmpty else { return true }
        let tags = session.tags ?? []
        let hay = filterHaystack(session)
        func matches(_ t: FilterToken) -> Bool {
            t.isTag
                ? tags.contains { $0.caseInsensitiveCompare(t.text) == .orderedSame }
                : hay.contains(t.text)
        }
        for t in tokens where !t.negate {
            if !matches(t) { return false }
        }
        for t in tokens where t.negate {
            if matches(t) { return false }
        }
        return true
    }

    private func paletteRows() -> [PaletteRow] {
        let tokens = activeFilters()
        // Hidden rows are included and flagged; the palette groups them under a
        // collapsed "Hidden (N)" divider rather than dropping them, mirroring the
        // mobile board and hub-jumplist.html.
        return orderedSessions().filter { session in
            passesFilters(session, tokens)
        }.map { session in
            let event = session.event
            // Unread per Slack grammar = unacked needs-you; acked rows are
            // dealt with and must never be suggested as next-to-check or
            // visited by Tab.
            let unread = !session.acked && needsCheck(event.event)
            return PaletteRow(
                sessionKey: event.sessionKey,
                mark: statusMark(event: event.event, acked: session.acked),
                statusWord: statusWord(event.event),
                // The amber mark carries the ask; this flag drives the
                // preview's bullet and action-line treatment.
                isAsking: !session.acked && event.event == "attention",
                isUnread: unread,
                isRead: session.acked && event.event != "busy",
                agent: event.agent,
                name: displayName(for: event, label: session.label),
                ageStart: sessionAgeStart(session),
                detail: session.detail,
                reply: session.reply,
                location: locationText(for: session),
                needsCheck: unread,
                engagedDate: session.engagedDate,
                tags: session.tags ?? [],
                pinned: session.pinned,
                isHidden: session.hidden
            )
        }
    }

    // Contract: a working row's age is time running, not time since the
    // latest busy re-fire (each prompt refreshes ts but not the work start).
    private func sessionAgeStart(_ session: Session) -> Date {
        guard session.event.event == "busy" else { return session.date }
        return session.busySince ?? session.date
    }

    // MARK: - Action-line location (contract v4)

    // Known terminal bundle ids resolve without a Launch Services lookup -
    // and, more importantly, without needing the app installed locally (the
    // event may come from another host).
    private static let knownTerminals: [String: String] = [
        "com.googlecode.iterm2": "iTerm",
        "com.mitchellh.ghostty": "Ghostty",
        "com.apple.terminal": "Terminal",
        "dev.warp.warp-stable": "Warp",
        "net.kovidgoyal.kitty": "kitty",
        "com.github.wez.wezterm": "WezTerm",
        "org.alacritty": "Alacritty",
        "io.alacritty": "Alacritty",
        "co.zeit.hyper": "Hyper",
        "com.microsoft.vscode": "VS Code",
    ]
    private var terminalNameCache: [String: String] = [:]

    private func terminalDisplayName(bundleID: String?) -> String {
        guard let bundleID, !bundleID.isEmpty else { return "terminal" }
        let key = bundleID.lowercased()
        if let known = Self.knownTerminals[key] { return known }
        if let cached = terminalNameCache[key] { return cached }
        var name: String?
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
           let bundle = Bundle(url: url) {
            name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
            if name?.isEmpty != false { name = url.deletingPathExtension().lastPathComponent }
        }
        // Unresolvable id (e.g. an app only installed on the origin host):
        // its last segment ("iterm2") beats showing reverse-DNS plumbing.
        let resolved = name ?? bundleID.split(separator: ".").last.map(String.init) ?? bundleID
        terminalNameCache[key] = resolved
        return resolved
    }

    // Names the editor behind a cursor-kind origin from its captured bundle.
    // Cursor ships as a ToDesktop build whose reverse-DNS id is a meaningless
    // slug, so name it directly; VS Code and other forks resolve through the
    // terminal-name table (com.microsoft.VSCode -> "VS Code"). A missing bundle
    // defaults to Cursor, matching the CLI jump's own fallback.
    private func editorDisplayName(bundleID: String?) -> String {
        guard let bundleID, !bundleID.isEmpty else { return "Cursor" }
        if bundleID.lowercased() == "com.todesktop.230313mzl4w4u92" { return "Cursor" }
        return terminalDisplayName(bundleID: bundleID)
    }

    // The hub records bare hostnames; Bonjour-style ".local" suffixes differ
    // between capture points, so compare with the suffix stripped.
    private static let localHostName: String = {
        let host = ProcessInfo.processInfo.hostName.lowercased()
        return host.hasSuffix(".local") ? String(host.dropLast(6)) : host
    }()

    /// Whether a host on the wire names this machine. Emitters send the
    /// hostname verbatim ("M-J7H7N07NPX"), while localHostName is lowercased
    /// and stripped of ".local" - so the two never match raw, and comparing
    /// them directly is always false. Every host comparison goes through here.
    private func isLocalHost(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return false }
        var normalized = host.lowercased()
        if normalized.hasSuffix(".local") { normalized = String(normalized.dropLast(6)) }
        return normalized == "localhost" || normalized == Self.localHostName
    }

    private func hostDisplay(_ host: String?) -> String {
        guard let host, !host.isEmpty else { return "localhost" }
        return isLocalHost(host) ? "localhost" : host
    }

    // The preview's action line: where Enter takes you, derived entirely from
    // data captured at fire time (origin + host) - never local topology.
    private func locationText(for session: Session) -> String {
        if let tmux = session.origin?.tmux {
            let app = terminalDisplayName(bundleID: tmux.terminal)
            var coords = "tmux"
            if let name = tmux.session, !name.isEmpty {
                coords = "tmux \(name)"
                if let window = tmux.window { coords += ":\(window)" }
            }
            return "Jump to \(app) (\(coords)) on \(hostDisplay(session.event.host))"
        }
        if let cursor = session.origin?.cursor {
            // Window-level focus only - editor tabs aren't externally
            // addressable (see specs/adapters.md). Name the editor from the
            // captured bundle so a VS Code-hosted session doesn't read as Cursor.
            let folder = session.event.title ?? "session"
            return "Jump to \(editorDisplayName(bundleID: cursor.bundle)) (\(folder)) on \(hostDisplay(session.event.host))"
        }
        if let raw = session.origin?.url, let url = URL(string: raw), let domain = url.host {
            if domain.lowercased() == "github.com" || domain.lowercased().hasSuffix(".github.com") {
                let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                return path.isEmpty ? "Open on GitHub" : "Open on GitHub (\(path))"
            }
            return "Open \(domain)"
        }
        // No origin captured: Enter still asks the CLI to jump; say so
        // without inventing a destination.
        return "Jump to session"
    }

    // MARK: - UI

    private func refreshUI() {
        updateStatusIcon()
        rebuildMenu()
        palette?.reloadIfVisible()
    }

    // Control-Center style: the icon plus one status dot, highest urgency
    // wins - red = failed (fix) > amber = needs your input (act) > blue =
    // output updated (look). Counts moved into the menu/palette; the dot only
    // covers unacked, unhidden rows so a dealt-with board goes quiet.
    private func updateStatusIcon() {
        var attention = 0, unread = 0, errors = 0
        for session in sessions.values where !session.acked && !session.hidden {
            switch session.event.event {
            case "attention": attention += 1
            case "done": unread += 1
            case "error": errors += 1
            default: break
            }
        }
        let dot: StatusDot?
        if errors > 0 {
            dot = .failed
        } else if attention > 0 {
            dot = .attention
        } else if unread > 0 {
            dot = .output
        } else {
            dot = nil
        }
        statusItem.button?.image = statusItemImage(style: .current, dot: dot)
    }

    // Shared by the menu and the palette so both surfaces agree.
    private func orderedSessions() -> [Session] {
        order.compactMap { sessions[$0] }
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        if cliMissing {
            // jump/hide/remove are dead without the CLI; a session list that
            // ignores clicks with no explanation reads as a broken app.
            let item = NSMenuItem(
                title: "signalbox CLI not found - brew install dwmkerr/tools/signalbox (or set SIGNALBOX_BIN)",
                action: nil,
                keyEquivalent: ""
            )
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(.separator())
        }
        // Contract: one row per session in /state order. The Slack grammar
        // (marks + weight), not filtering, says what needs you - the working
        // set stays spatially stable; hidden rows drop out, as do sessions
        // outside the additional filters (Settings) so the menu matches the
        // jumplist.
        let tokens = activeFilters()
        let visible = orderedSessions().filter {
            !$0.hidden && passesFilters($0, tokens)
        }
        if visible.isEmpty {
            let item = NSMenuItem(title: "No sessions", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        let now = Date()
        for session in visible {
            let event = session.event
            let item = NSMenuItem(title: "", action: #selector(jumpMenuItem(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = event.sessionKey
            let mark = statusMark(event: event.event, acked: session.acked)
            // Status is carried by the mark, same as palette rows - no words.
            item.image = menuSymbol(for: mark, word: statusWord(event.event))
            item.attributedTitle = menuTitle(
                agent: event.agent,
                name: displayName(for: event, label: session.label),
                age: ageString(from: sessionAgeStart(session), to: now),
                unread: !session.acked && needsCheck(event.event),
                read: session.acked && event.event != "busy",
                pinned: session.pinned
            )
            // No "?" badge: the amber mark alone says asking (amber scheme).
            menu.addItem(item)
        }
        menu.addItem(.separator())
        // No Refresh item: the stream resyncs /state on every (re)connect and
        // on wake, so a manual refresh had nothing left to fix.
        let connectItem = NSMenuItem(
            title: "Connect Phone…", action: #selector(openConnectPhone), keyEquivalent: ""
        )
        connectItem.target = self
        connectItem.image = connectPhoneMenuIcon()
        menu.addItem(connectItem)
        let settingsItem = NSMenuItem(
            title: "Settings…", action: #selector(openSettings), keyEquivalent: ","
        )
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(NSMenuItem(
            title: "Quit Signalbox",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        ))
    }

    // A small phone glyph on the Connect Phone item. Template-rendered so it
    // takes the menu's own label color like a system menu image; the QR glyph
    // is the fallback on the rare system without an "iphone" symbol.
    private func connectPhoneMenuIcon() -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        let base = NSImage(systemSymbolName: "iphone", accessibilityDescription: "Connect Phone")
            ?? NSImage(systemSymbolName: "qrcode", accessibilityDescription: "Connect Phone")
        let image = base?.withSymbolConfiguration(config)
        image?.isTemplate = true
        return image
    }

    private func menuSymbol(for mark: StatusMark, word: String) -> NSImage? {
        // paletteColors bakes the tint into the image: NSMenuItem has no
        // contentTintColor, and template rendering would draw plain label
        // color. A menu is transient, so working is the static dotted circle
        // rather than a live spinner.
        let size: CGFloat = (mark == .attention || mark == .unread || mark == .read) ? 9 : 12
        let weight: NSFont.Weight = mark == .read ? .light : .regular
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
            .applying(NSImage.SymbolConfiguration(paletteColors: [markColor(mark)]))
        return NSImage(systemSymbolName: markSymbolName(mark), accessibilityDescription: word)?
            .withSymbolConfiguration(config)
    }

    // A small dim pin as an NSTextAttachment, for the pinned-row marker in the
    // dropdown titles. Color baked in (menu attachments do not take a tint).
    private func pinMenuGlyph(size: CGFloat) -> NSTextAttachment? {
        let config = NSImage.SymbolConfiguration(pointSize: size - 3, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.secondaryLabelColor]))
        guard let image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "Pinned")?
            .withSymbolConfiguration(config) else { return nil }
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(x: 0, y: -1, width: image.size.width, height: image.size.height)
        return attachment
    }

    private func menuTitle(
        agent: String, name: String, age: String, unread: Bool, read: Bool, pinned: Bool
    ) -> NSAttributedString {
        let size = NSFont.systemFontSize
        let text = NSMutableAttributedString()
        if pinned, let pin = pinMenuGlyph(size: size) {
            // A quiet pin ahead of the glyph marks pinned rows in the dropdown,
            // the same signal as the palette's pin mark.
            text.append(NSAttributedString(attachment: pin))
            text.append(NSAttributedString(string: " "))
        }
        if !agent.isEmpty {
            // The agent glyph (same as the jumplist rows) instead of its name -
            // an at-a-glance icon reads faster than "claude · ".
            let attachment = NSTextAttachment()
            attachment.image = AgentGlyphView.image(for: agent)
            attachment.bounds = CGRect(x: 0, y: -4, width: 18, height: 16)
            text.append(NSAttributedString(attachment: attachment))
            text.append(NSAttributedString(string: "  "))
        }
        // Bold = unread, dimmer regular = read, per the row grammar. The name
        // carries no explicit color when live so the menu's own highlight
        // treatment still applies.
        var nameAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: unread ? .bold : .regular),
        ]
        if read { nameAttributes[.foregroundColor] = NSColor.secondaryLabelColor }
        text.append(NSAttributedString(string: name, attributes: nameAttributes))
        text.append(NSAttributedString(string: "  \(age)", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: size - 1, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        return text
    }

    // The user's own label always beats the agent title, which beats the cwd
    // basename - matching the CLI's titleOf.
    private func displayName(for event: SessionEvent, label: String?) -> String {
        if let label, !label.isEmpty { return label }
        if let title = event.title, !title.isEmpty { return title }
        if let cwd = event.cwd, !cwd.isEmpty { return (cwd as NSString).lastPathComponent }
        return event.sessionKey
    }

    @objc private func openSettings() {
        settings?.show()
    }

    @objc private func openConnectPhone() {
        connectPhone?.show()
    }

    @objc private func jumpMenuItem(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        jump(to: key)
    }

    // MARK: - Commands

    /// Acts on a command off the hub's command frame. Every machine watching
    /// the hub sees every command, so this is also the filter deciding it is
    /// ours: a phone cannot jump, but it can ask the machine that owns the
    /// session to, and that machine is the only one that may answer.
    private func perform(_ command: HubCommand) {
        guard command.command == "jump" else { return }
        // Two independent checks, both required. The caller's target_host is
        // what it read off the row it tapped; the session's own host is what
        // this app knows. Requiring both means a disagreement - a stale row on
        // the phone, a session that moved - does nothing, rather than jumping
        // on the wrong machine. Unknown session fails closed for the same reason.
        guard isLocalHost(command.targetHost) else { return }
        guard let session = sessions[command.sessionKey],
              isLocalHost(session.event.host) else { return }
        jump(to: command.sessionKey)
    }

    // MARK: - CLI actions (jump/hide/remove logic lives in the CLI only)

    func jump(to sessionKey: String) {
        // Jump auto-acks via the CLI (`seen` fires on success) - no app-side ack.
        // That ack is also how a remote caller learns its jump landed: `seen`
        // only fires once the switch actually happened, so the board going
        // quiet is proof of success rather than mere receipt.
        runSignalbox(["jump", sessionKey])
    }

    /// Fires `signalbox hide` - the resulting `hide` event comes back over SSE
    /// and suppresses the row (or acks it, if busy); the app never mutates
    /// hide state locally.
    func hide(sessionKey: String) {
        runSignalbox(["hide", sessionKey])
    }

    /// Fires `signalbox show` - the resulting `show` event clears the hidden
    /// flag over SSE, returning the row to the main list; the app never mutates
    /// hide state locally.
    func show(sessionKey: String) {
        runSignalbox(["show", sessionKey])
    }

    /// Fires `signalbox remove` - the hub answers with `ended` over SSE, which
    /// deletes the row for every surface at once.
    func remove(sessionKey: String) {
        runSignalbox(["remove", sessionKey])
    }

    /// Fires `signalbox label` - signalbox's own display name for the session
    /// (palette `r`). Empty text clears back to the agent title; the hub
    /// echoes the label event over SSE so every surface renames at once.
    func setLabel(sessionKey: String, text: String) {
        var arguments = ["label", sessionKey]
        if !text.isEmpty { arguments.append(text) }
        runSignalbox(arguments)
    }

    /// Fires `signalbox session pin|unpin` - the hub echoes the pin/unpin event
    /// over SSE and returns pinned-first order on the next /state, so every
    /// surface repositions at once. The app never mutates pin order locally.
    func setPinned(sessionKey: String, pinned: Bool) {
        runSignalbox(["session", pinned ? "pin" : "unpin", sessionKey])
    }

    private func runSignalbox(_ arguments: [String]) {
        runningProcesses.removeAll { !$0.isRunning }
        guard let binary = resolveSignalboxBinary() else {
            reportMissingCLI()
            return
        }
        // The CLI can appear after launch (e.g. brew install while the app is
        // running) - clear the missing-CLI banner once resolution succeeds.
        if cliMissing {
            cliMissing = false
            rebuildMenu()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            runningProcesses.append(process)
        } catch {
            NSLog("Signalbox: failed to run signalbox \(arguments.first ?? ""): \(error)")
        }
    }

    private func resolveSignalboxBinary() -> String? {
        SignalboxCLI.resolve()
    }

    /// jump/hide/remove all run through the CLI, so a missing binary makes the
    /// app look broken with no explanation - tell the user visibly: a
    /// persistent disabled menu row plus a one-time notification.
    private func reportMissingCLI() {
        NSLog("Signalbox: signalbox binary not found (set SIGNALBOX_BIN or add it to PATH)")
        guard !cliMissing else { return }
        cliMissing = true
        rebuildMenu()
        guard notificationsAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = "signalbox CLI not found"
        content.body = "Install it (brew install dwmkerr/tools/signalbox) or set SIGNALBOX_BIN - jump, hide and remove need the CLI."
        // Fixed identifier so repeated failures collapse into one banner.
        let request = UNNotificationRequest(
            identifier: "signalbox-cli-missing", content: content, trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        // Ages are rendered into the titles, so recompute them at open time.
        rebuildMenu()
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Extract the Sendable key here; the response object must not cross actors.
        let key = response.notification.request.content.userInfo["session_key"] as? String
        completionHandler()
        guard let key else { return }
        Task { @MainActor in self.jump(to: key) }
    }
}
