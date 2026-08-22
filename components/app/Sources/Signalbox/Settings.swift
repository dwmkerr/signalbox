import AppKit
import KeyboardShortcuts

// SharedSettings reads/writes ~/.config/signalbox/settings.json - the flat
// file the CLI hooks also read (cli/src/config.ts), so a toggle flipped here
// changes hook behaviour without any IPC. Writes merge, never clobber:
// unknown keys other tools put there survive.
@MainActor
enum SharedSettings {
    private static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/signalbox/settings.json")
    }

    private static func read() -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    private static func write(_ settings: [String: Any]) {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(
            withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]
        ) {
            // Atomic (write-temp-then-rename) so a concurrent reader - the CLI
            // hooks, or the hub reading hub.* - never sees a half-written file.
            try? data.write(to: url, options: [.atomic])
        }
    }

    // Intent, not reality: what the user last asked the hub to do. Never render
    // a running hub from these - /healthz is the only thing that knows. They are
    // here because the app has no other source for the upstream bearer, which
    // never appears on /healthz, and because a hub that has never answered has
    // to be named somehow.
    static var hubUpstream: String {
        let hub = read()["hub"] as? [String: Any]
        return hub?["upstream"] as? String ?? ""
    }

    static var hubToken: String {
        let hub = read()["hub"] as? [String: Any]
        return hub?["token"] as? String ?? ""
    }

    // The remembered address of the remote hub, which no mode switch clears -
    // hub.upstream has to go empty for Local and LAN (it is what makes the hub
    // a forwarder), and losing the address with it means retyping it on every
    // round trip. The app owns this key; the hub never reads it. An older
    // config that only has hub.upstream still pre-fills the field.
    static var hubRemoteURL: String {
        let hub = read()["hub"] as? [String: Any]
        let remembered = hub?["remoteUrl"] as? String ?? ""
        return remembered.isEmpty ? (hub?["upstream"] as? String ?? "") : remembered
    }

    // Settings intent is used only when no hub has answered this session.
    static var intentMode: HubDisplayMode {
        let hub = read()["hub"] as? [String: Any]
        if let upstream = hub?["upstream"] as? String, !upstream.isEmpty {
            return .remote
        }
        if let bind = hub?["bind"] as? String, !bind.isEmpty, !isLoopback(bind) {
            return .lan
        }
        return .local
    }


    // Loopback binds only answer this Mac; every other address exposes the hub
    // to other devices on the network.
    private static func isLoopback(_ bind: String) -> Bool {
        let normalized = bind.lowercased()
        return normalized.hasPrefix("127.")
            || ["::1", "localhost", "loopback"].contains(normalized)
    }

    // A leftover upstream would keep forwarding regardless of the loopback
    // bind, so both keys have to move together when Local is confirmed.
    static func applyLocalMode() {
        updateHub(["bind": "127.0.0.1", "upstream": ""])
    }

    // The hub mints and preserves its bearer when a wide bind needs one.
    static func applyLANMode() {
        updateHub(["bind": "0.0.0.0", "upstream": ""])
    }

    // A forwarder serves loopback only. Keeping a wide bind adds a warning at
    // startup and makes the saved intent harder to understand. remoteUrl
    // carries the same address past a later switch to Local or LAN, which have
    // to clear upstream.
    static func applyRemoteMode(upstream: String, token: String) {
        updateHub([
            "bind": "127.0.0.1", "upstream": upstream, "remoteUrl": upstream, "token": token,
        ])
    }

    private static func updateHub(_ values: [String: Any]) {
        var root = read()
        var hub = root["hub"] as? [String: Any] ?? [:]
        for (key, value) in values {
            hub[key] = value
        }
        root["hub"] = hub
        write(root)
    }

    static var claudeClearEnds: Bool {
        get { read()["claudeClearEnds"] as? Bool ?? true }
        set {
            var s = read()
            s["claudeClearEnds"] = newValue
            write(s)
        }
    }

    static var claudeRenameTitle: Bool {
        get { read()["claudeRenameTitle"] as? Bool ?? true }
        set {
            var s = read()
            s["claudeRenameTitle"] = newValue
            write(s)
        }
    }

    // The Codex pair of the two toggles above (specs/adapters.md).
    static var codexClearEnds: Bool {
        get { read()["codexClearEnds"] as? Bool ?? true }
        set {
            var s = read()
            s["codexClearEnds"] = newValue
            write(s)
        }
    }

    static var codexRenameTitle: Bool {
        get { read()["codexRenameTitle"] as? Bool ?? true }
        set {
            var s = read()
            s["codexRenameTitle"] = newValue
            write(s)
        }
    }

    // Off by default: indexing reads every transcript on the machine, which is
    // work and disk nobody should spend without asking (specs/search.md).
    static var searchEnabled: Bool {
        get { read()["searchEnabled"] as? Bool ?? false }
        set {
            var s = read()
            s["searchEnabled"] = newValue
            write(s)
        }
    }
}

enum SettingsTab: String, CaseIterable {
    case general, agents, hub, logs

    var title: String { rawValue.capitalized }
    var toolbarIdentifier: NSToolbarItem.Identifier {
        NSToolbarItem.Identifier("settings.\(rawValue)")
    }

    init?(toolbarIdentifier: NSToolbarItem.Identifier) {
        guard let tab = Self.allCases.first(where: { $0.toolbarIdentifier == toolbarIdentifier })
        else { return nil }
        self = tab
    }

    var symbolNames: [String] {
        switch self {
        case .general: return ["gearshape"]
        case .agents: return ["terminal"]
        case .hub: return ["dot.radiowaves.left.and.right", "antenna.radiowaves.left.and.right"]
        case .logs: return ["doc.plaintext"]
        }
    }
}

@MainActor
private final class LogsAppearanceStack: NSStackView {
    var onAppearanceChange: ((NSAppearance) -> Void)?

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?(effectiveAppearance)
    }
}

// One preferences window owns the app-only settings, the shared agent toggles
// and the hub's live status. Its toolbar stays fixed as agent types and hub
// controls grow independently.
@MainActor
final class SettingsController: NSObject, NSTextFieldDelegate, NSWindowDelegate, NSToolbarDelegate {
    // The board's tag filter, shared with AppDelegate. Kept in UserDefaults
    // (a local view preference, not shared config): set it here to a tag and
    // the jumplist shows only sessions carrying it - the quiet way to flip to
    // `demo` for a recording and back to real work. Blank = all sessions.
    static let tagFilterKey = "tagFilter"

    private let onIconChange: @MainActor () -> Void
    private let onFilterChange: @MainActor () -> Void
    private let onPairDevice: @MainActor () -> Void
    private let monitor: HubHealthMonitor
    // A confirmed mode change must use the supervisor's restart path so the
    // app keeps owning exactly one hub process.
    private let restartHub: @MainActor () async -> Void
    private var window: NSWindow?
    private var panes: [SettingsTab: NSView] = [:]
    private var selectedTab: SettingsTab = .general
    private var iconPopup: NSPopUpButton?
    private var clearCheckbox: NSButton?
    private var searchCheckbox: NSButton?
    private var searchStatusLabel: NSTextField?
    private var searchStatusTimer: Timer?
    /// Asks the hub for index progress. Set by the app delegate.
    var searchStatusProvider: (@MainActor () async -> SearchIndexStatus?)?
    private var renameCheckbox: NSButton?
    private var codexClearCheckbox: NSButton?
    private var codexRenameCheckbox: NSButton?
    private var filterField: NSTextField?
    private var hubModePopup: NSPopUpButton?
    private var statusPill: NSView?
    private var statusDot: NSView?
    private var statusPillLabel: NSTextField?
    private var modeCaption: NSTextField?
    private var topology: HubTopology?
    private var modeControlsContainer: NSView?
    private var confirmButtonsContainer: NSView?
    private var pendingHintRow: NSView?
    private var pendingHint: NSTextField?
    private var remoteURLField: NSTextField?
    private var remoteTokenField: NSSecureTextField?
    // What was last typed into those fields, kept while another mode is shown.
    private var remoteURLDraft: String?
    private var remoteTokenDraft: String?
    private var testLine: NSTextField?
    private var remoteTestTask: Task<Void, Never>?
    private var versionLabel: NSTextField?
    private var logTextView: NSTextView?
    private var logToastLabel: NSTextField?
    private var logToastTimer: Timer?
    private var selectedMode: HubDisplayMode
    private var runningMode: HubDisplayMode
    // A test result belongs to the exact address and bearer that were tested.
    // Any edit invalidates it so Confirm can never apply untested credentials.
    private var testPassed = false

    private static let paneWidth: CGFloat = 500
    private static let logReadLimit: UInt64 = 512 * 1024
    private static let offeredHubModes: [HubDisplayMode] = [.local, .lan, .remote]

    private static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state/signalbox/hub.log")
    }

    private var pending: Bool { selectedMode != runningMode }

    init(
        monitor: HubHealthMonitor,
        onIconChange: @escaping @MainActor () -> Void,
        onFilterChange: @escaping @MainActor () -> Void,
        onPairDevice: @escaping @MainActor () -> Void,
        restartHub: @escaping @MainActor () async -> Void
    ) {
        let intentMode = SharedSettings.intentMode
        self.monitor = monitor
        self.onIconChange = onIconChange
        self.onFilterChange = onFilterChange
        self.onPairDevice = onPairDevice
        self.restartHub = restartHub
        self.selectedMode = intentMode
        self.runningMode = intentMode
        super.init()
        #if DEBUG
        HubStatus.runSelfCheck()
        #endif
    }

    func show(tab: SettingsTab? = nil) {
        if window == nil { build() }
        applyHealth()
        select(tab: tab ?? selectedTab)
        // A settings window nobody has open has no business talking to the hub
        // every few seconds, so this surface owns one reference to the monitor.
        monitor.begin("settings") { [weak self] in self?.applyHealth() }
        // A first build takes minutes, so the line has to move while the window
        // is open; a static count reads as a stuck toggle. Only while open, for
        // the same reason the health monitor is reference counted.
        refreshSearchStatus()
        searchStatusTimer?.invalidate()
        searchStatusTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) {
            [weak self] _ in
            Task { @MainActor in self?.refreshSearchStatus() }
        }
        // Accessory apps stay background by default; a settings window is a
        // real window and needs the app frontmost to take keys and clicks.
        // orderFrontRegardless because activate alone can leave the window
        // behind the previous app on modern macOS.
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    private func build() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = selectedTab.title
        window.toolbarStyle = .preference
        window.isReleasedWhenClosed = false
        window.delegate = self

        let toolbar = NSToolbar(identifier: "SignalboxSettingsToolbar")
        toolbar.delegate = self
        toolbar.allowsUserCustomization = false
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar

        panes = [
            .general: buildGeneralPane(),
            .agents: buildAgentsPane(),
            .hub: buildHubPane(),
            .logs: buildLogsPane(),
        ]

        // The version sits quietly at the bottom of every pane - the discreet
        // "which build am I on" belongs in Settings, not the menu.
        let versionLabel = NSTextField(labelWithString: "Signalbox \(Self.appVersion())")
        versionLabel.font = .systemFont(ofSize: 11)
        versionLabel.textColor = .tertiaryLabelColor
        self.versionLabel = versionLabel

        self.window = window
        select(tab: selectedTab)
        window.center()
    }

    private func buildGeneralPane() -> NSView {
        let iconLabel = rowLabel("Menu bar icon:")
        // A popup, per the settings spec - not radio buttons.
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        for style in MenuBarIconStyle.allCases {
            popup.addItem(withTitle: style.displayName)
            popup.lastItem?.image = statusItemImage(style: style, dot: nil)
            popup.lastItem?.representedObject = style.rawValue
        }
        popup.selectItem(at: MenuBarIconStyle.allCases.firstIndex(of: .current) ?? 0)
        popup.target = self
        popup.action = #selector(iconStyleChanged(_:))
        self.iconPopup = popup
        let iconRow = horizontalRow([iconLabel, popup])

        let shortcutLabel = rowLabel("Jumplist shortcut:")
        let recorder = KeyboardShortcuts.RecorderCocoa(for: .openJumplist)
        recorder.widthAnchor.constraint(equalToConstant: 130).isActive = true
        let shortcutRow = horizontalRow([shortcutLabel, recorder])
        let shortcutCaption = caption("Press the field to record a global shortcut")
        let shortcutCaptionIndent = NSView()
        let shortcutCaptionRow = horizontalRow([shortcutCaptionIndent, shortcutCaption])

        let filterLabel = rowLabel("Additional filters:")
        let filterField = NSTextField(
            string: UserDefaults.standard.string(forKey: Self.tagFilterKey) ?? ""
        )
        filterField.placeholderString = "#tag or name"
        filterField.delegate = self
        filterField.target = self
        filterField.action = #selector(filterChanged(_:))
        filterField.widthAnchor.constraint(equalToConstant: 200).isActive = true
        self.filterField = filterField
        let filterRow = horizontalRow([filterLabel, filterField])
        let filterCaption = caption("Always applied on the jumplist")

        for label in [iconLabel, shortcutLabel, filterLabel] {
            label.alignment = .right
        }

        // The caption belongs to the field, so it starts where the field does.
        let captionIndent = NSView()
        let captionRow = horizontalRow([captionIndent, filterCaption])

        let searchHeading = sectionHeading("Session contents search")
        let searchCheckbox = NSButton(
            checkboxWithTitle: "Search inside session transcripts",
            target: self,
            action: #selector(searchEnabledChanged(_:))
        )
        searchCheckbox.state = SharedSettings.searchEnabled ? .on : .off
        self.searchCheckbox = searchCheckbox
        let searchCaption = caption(
            "Indexes the conversations on this machine so the jumplist can find a session "
            + "by something said inside it, including sessions that have ended. The index "
            + "stays on this machine and is never sent to a hub."
        )
        let searchStatus = caption("")
        self.searchStatusLabel = searchStatus

        let stack = verticalStack([
            iconRow, shortcutRow, shortcutCaptionRow, filterRow, captionRow,
            searchHeading, searchCheckbox, searchCaption, searchStatus,
        ])
        stack.setCustomSpacing(2, after: filterRow)
        stack.setCustomSpacing(16, after: captionRow)
        stack.setCustomSpacing(4, after: searchHeading)
        stack.setCustomSpacing(2, after: searchCheckbox)
        stack.setCustomSpacing(6, after: searchCaption)
        // One label column, right aligned, so the three controls line up the
        // way every other settings window on macOS lays a form out. Activated
        // only now: cross-row constraints need the shared stack ancestor, and
        // activating them earlier throws (AppKit catches it, which silently
        // killed this window).
        for view in [shortcutLabel, filterLabel, shortcutCaptionIndent, captionIndent] {
            view.widthAnchor.constraint(equalTo: iconLabel.widthAnchor).isActive = true
        }
        return pane(containing: stack)
    }

    private func buildAgentsPane() -> NSView {
        // These toggles live in the shared settings file so the CLI hooks read
        // the same choices the app writes without any IPC.
        let claudeHeading = sectionHeading("Claude Code")

        let clearCheckbox = NSButton(
            checkboxWithTitle: "Remove the session on /clear",
            target: self,
            action: #selector(clearEndsChanged(_:))
        )
        clearCheckbox.state = SharedSettings.claudeClearEnds ? .on : .off
        self.clearCheckbox = clearCheckbox

        let renameCheckbox = NSButton(
            checkboxWithTitle: "Rename the session on /rename",
            target: self,
            action: #selector(renameTitleChanged(_:))
        )
        renameCheckbox.state = SharedSettings.claudeRenameTitle ? .on : .off
        self.renameCheckbox = renameCheckbox

        let claudeCaption = caption(
            "Off, a /clear keeps the old session listed until you hide or remove it. "
                + "Your own rename always wins."
        )

        let codexHeading = sectionHeading("Codex")
        let codexClearCheckbox = NSButton(
            checkboxWithTitle: "Remove the session on /clear",
            target: self,
            action: #selector(codexClearEndsChanged(_:))
        )
        codexClearCheckbox.state = SharedSettings.codexClearEnds ? .on : .off
        self.codexClearCheckbox = codexClearCheckbox

        let codexRenameCheckbox = NSButton(
            checkboxWithTitle: "Rename the session on /rename",
            target: self,
            action: #selector(codexRenameTitleChanged(_:))
        )
        codexRenameCheckbox.state = SharedSettings.codexRenameTitle ? .on : .off
        self.codexRenameCheckbox = codexRenameCheckbox

        let stack = verticalStack(
            [claudeHeading, clearCheckbox, renameCheckbox, claudeCaption,
             codexHeading, codexClearCheckbox, codexRenameCheckbox]
        )
        stack.setCustomSpacing(4, after: claudeHeading)
        stack.setCustomSpacing(4, after: clearCheckbox)
        stack.setCustomSpacing(2, after: renameCheckbox)
        stack.setCustomSpacing(16, after: claudeCaption)
        stack.setCustomSpacing(4, after: codexHeading)
        stack.setCustomSpacing(4, after: codexClearCheckbox)
        return pane(containing: stack)
    }

    private func buildHubPane() -> NSView {
        let modePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        for mode in Self.offeredHubModes {
            modePopup.addItem(withTitle: mode.rawValue)
        }
        modePopup.target = self
        modePopup.action = #selector(hubModeChanged(_:))
        self.hubModePopup = modePopup

        // Confirm and Cancel sit beside the popup that caused the pending
        // change, not at the far end of the pane where they read as a form
        // submit for everything above them.
        let modeLabel = rowLabel("Hub mode:")
        let confirmButtonsContainer = NSView()
        self.confirmButtonsContainer = confirmButtonsContainer
        let modeRow = horizontalRow([modeLabel, modePopup, confirmButtonsContainer])

        let pendingHint = caption("")
        self.pendingHint = pendingHint
        let hintIndent = NSView()
        let pendingHintRow = horizontalRow([hintIndent, pendingHint])
        self.pendingHintRow = pendingHintRow

        let pill = NSView()
        pill.wantsLayer = true
        pill.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.55).cgColor
        pill.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
        pill.layer?.borderWidth = 1
        pill.layer?.cornerRadius = 13
        pill.translatesAutoresizingMaskIntoConstraints = false
        self.statusPill = pill

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        self.statusDot = dot

        let pillLabel = NSTextField(labelWithString: "")
        pillLabel.isSelectable = true
        pillLabel.font = .systemFont(ofSize: 12)
        pillLabel.translatesAutoresizingMaskIntoConstraints = false
        self.statusPillLabel = pillLabel

        pill.addSubview(dot)
        pill.addSubview(pillLabel)
        NSLayoutConstraint.activate([
            pill.heightAnchor.constraint(equalToConstant: 26),
            dot.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 11),
            dot.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            pillLabel.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
            pillLabel.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -13),
            pillLabel.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])

        let modeCaption = caption("")
        self.modeCaption = modeCaption
        let topology = HubTopology()
        self.topology = topology

        // A fixed container keeps the mode-specific controls below the status
        // sketch as their contents change.
        let modeControlsContainer = NSView()
        modeControlsContainer.widthAnchor.constraint(equalToConstant: Self.paneWidth).isActive = true
        self.modeControlsContainer = modeControlsContainer

        let hubHeading = sectionHeading("Hub")
        let stack = verticalStack(
            [hubHeading, modeRow, pendingHintRow, pill, modeCaption, topology,
             modeControlsContainer]
        )
        // Cross-row constraint: legal only once the stack is the common
        // ancestor - activating it before the rows joined threw (and AppKit
        // swallows the throw, silently killing this window).
        hintIndent.widthAnchor.constraint(equalTo: modeLabel.widthAnchor).isActive = true
        stack.setCustomSpacing(4, after: hubHeading)
        stack.setCustomSpacing(4, after: modeRow)
        stack.setCustomSpacing(6, after: pendingHintRow)
        stack.setCustomSpacing(6, after: pill)
        stack.setCustomSpacing(6, after: modeCaption)
        stack.setCustomSpacing(8, after: topology)
        renderModeSelection()
        return pane(containing: stack)
    }

    private func buildLogsPane() -> NSView {
        let heading = sectionHeading("Hub log")
        let note = caption(
            "The hub writes everything it does here. Click the path to reveal it in Finder."
        )

        let pathButton = NSButton(
            title: "~/.local/state/signalbox/hub.log",
            target: self,
            action: #selector(revealLogInFinder)
        )
        pathButton.isBordered = false
        pathButton.alignment = .left
        pathButton.attributedTitle = NSAttributedString(
            string: "~/.local/state/signalbox/hub.log",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        pathButton.wantsLayer = true
        pathButton.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        pathButton.layer?.borderColor = NSColor.separatorColor.cgColor
        pathButton.layer?.borderWidth = 1
        pathButton.layer?.cornerRadius = 6
        pathButton.heightAnchor.constraint(equalToConstant: 27).isActive = true
        pathButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        pathButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copyButton = NSButton(
            title: "Copy path",
            target: self,
            action: #selector(copyLogPath)
        )
        copyButton.controlSize = .small
        let pathRow = horizontalRow([pathButton, copyButton])
        pathRow.widthAnchor.constraint(equalToConstant: Self.paneWidth).isActive = true

        let toast = NSTextField(labelWithString: "")
        toast.font = .systemFont(ofSize: 11)
        toast.textColor = .systemGreen
        toast.heightAnchor.constraint(equalToConstant: 16).isActive = true
        self.logToastLabel = toast

        let recentHeading = sectionHeading("Recent events")
        let rowSpacer = NSView()
        rowSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let refreshButton = NSButton(
            title: "Refresh",
            target: self,
            action: #selector(refreshLog)
        )
        refreshButton.controlSize = .small
        let recentRow = horizontalRow([recentHeading, rowSpacer, refreshButton])
        recentRow.widthAnchor.constraint(equalToConstant: Self.paneWidth).isActive = true

        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.backgroundColor = NSColor.textBackgroundColor
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.wantsLayer = true
        scrollView.layer?.borderColor = NSColor.separatorColor.cgColor
        scrollView.layer?.borderWidth = 1
        scrollView.layer?.cornerRadius = 6
        scrollView.widthAnchor.constraint(equalToConstant: Self.paneWidth).isActive = true
        scrollView.heightAnchor.constraint(equalToConstant: 175).isActive = true

        let textView = NSTextView(frame: scrollView.contentView.bounds)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = true
        textView.backgroundColor = scrollView.backgroundColor
        textView.textColor = NSColor.secondaryLabelColor
        textView.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        textView.textContainerInset = NSSize(width: 10, height: 7)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.autoresizingMask = [.width, .height]
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = false
        scrollView.documentView = textView
        self.logTextView = textView

        let stack = LogsAppearanceStack(
            views: [heading, note, pathRow, toast, recentRow, scrollView]
        )
        // cgColor is a resolved snapshot, so refresh the layer colors when the
        // Logs view changes appearance.
        stack.onAppearanceChange = { appearance in
            appearance.performAsCurrentDrawingAppearance {
                pathButton.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
                pathButton.layer?.borderColor = NSColor.separatorColor.cgColor
                scrollView.layer?.borderColor = NSColor.separatorColor.cgColor
            }
        }
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.setCustomSpacing(4, after: heading)
        stack.setCustomSpacing(8, after: note)
        stack.setCustomSpacing(5, after: pathRow)
        stack.setCustomSpacing(8, after: toast)
        stack.setCustomSpacing(4, after: recentRow)
        return pane(containing: stack)
    }

    private func pane(containing stack: NSStackView) -> NSView {
        let pane = NSView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        pane.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: pane.topAnchor),
            stack.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: pane.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: Self.paneWidth),
        ])
        return pane
    }

    private func verticalStack(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        return stack
    }

    private func horizontalRow(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        return stack
    }

    private func rowLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        return label
    }

    private func sectionHeading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }

    private func caption(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = Self.paneWidth
        return label
    }

    private func select(tab: SettingsTab) {
        guard let window, let pane = panes[tab], let versionLabel else { return }
        selectedTab = tab
        window.title = tab.title
        window.toolbar?.selectedItemIdentifier = tab.toolbarIdentifier

        pane.removeFromSuperview()
        versionLabel.removeFromSuperview()
        let content = NSView()
        content.addSubview(pane)
        content.addSubview(versionLabel)
        pane.translatesAutoresizingMaskIntoConstraints = false
        versionLabel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pane.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            pane.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            pane.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            versionLabel.topAnchor.constraint(equalTo: pane.bottomAnchor, constant: 12),
            versionLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            versionLabel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
        ])

        let paneSize = pane.fittingSize
        let versionSize = versionLabel.fittingSize
        let contentSize = NSSize(
            width: max(paneSize.width, versionSize.width) + 40,
            height: 20 + paneSize.height + 12 + versionSize.height + 14
        )
        let oldTop = window.frame.maxY
        window.contentView = content
        window.setContentSize(contentSize)
        if window.isVisible {
            var frame = window.frame
            frame.origin.y = oldTop - frame.height
            window.setFrame(frame, display: true)
        }

        // This is a snapshot rather than a live follow, so lines do not move
        // while someone reads. Selection and Refresh are the only reloads.
        if tab == .logs { refreshLogTail() }
    }

    @objc private func toolbarTabSelected(_ sender: NSToolbarItem) {
        guard let tab = SettingsTab(toolbarIdentifier: sender.itemIdentifier) else { return }
        select(tab: tab)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        guard let tab = SettingsTab(toolbarIdentifier: itemIdentifier) else { return nil }
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.label = tab.title
        item.paletteLabel = tab.title
        item.toolTip = tab.title
        item.image = tab.symbolNames.lazy.compactMap {
            NSImage(systemSymbolName: $0, accessibilityDescription: tab.title)
        }.first
        item.target = self
        item.action = #selector(toolbarTabSelected(_:))
        return item
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsTab.allCases.map(\.toolbarIdentifier)
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsTab.allCases.map(\.toolbarIdentifier)
    }

    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsTab.allCases.map(\.toolbarIdentifier)
    }

    func windowWillClose(_ notification: Notification) {
        monitor.end("settings")
        searchStatusTimer?.invalidate()
        searchStatusTimer = nil
        logToastTimer?.invalidate()
        logToastTimer = nil
        logToastLabel?.stringValue = ""
    }

    @objc private func revealLogInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Self.logURL])
        showLogToast("Revealed hub.log in Finder.")
    }

    @objc private func copyLogPath() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(Self.logURL.path, forType: .string)
        showLogToast("Copied the path.")
    }

    @objc private func refreshLog() {
        refreshLogTail()
    }

    private func showLogToast(_ message: String) {
        logToastTimer?.invalidate()
        logToastLabel?.stringValue = message
        let timer = Timer(
            timeInterval: 2.5,
            target: self,
            selector: #selector(clearLogToast),
            userInfo: nil,
            repeats: false
        )
        RunLoop.main.add(timer, forMode: .common)
        logToastTimer = timer
    }

    @objc private func clearLogToast() {
        logToastTimer?.invalidate()
        logToastTimer = nil
        logToastLabel?.stringValue = ""
    }

    private func refreshLogTail() {
        logTextView?.string = Self.readLogTail()
        // A text view in a hidden tab has no useful layout yet, so scrolling
        // waits until AppKit has installed and laid out the visible pane.
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self, let textView = self.logTextView else { return }
            self.window?.contentView?.layoutSubtreeIfNeeded()
            textView.scrollToEndOfDocument(nil)
            // scrollToEndOfDocument lands on the END of the last line, so a long
            // line opens scrolled past its timestamp; a log is read left to right.
            guard let scroll = textView.enclosingScrollView else { return }
            let clip = scroll.contentView
            clip.scroll(to: NSPoint(x: 0, y: clip.bounds.origin.y))
            scroll.reflectScrolledClipView(clip)
        }
    }

    private static func readLogTail() -> String {
        let missingMessage = "The hub has not written a log yet."
        guard FileManager.default.fileExists(atPath: logURL.path),
              let handle = try? FileHandle(forReadingFrom: logURL)
        else { return missingMessage }
        defer { try? handle.close() }

        do {
            let end = try handle.seekToEnd()
            let start = end > logReadLimit ? end - logReadLimit : 0
            try handle.seek(toOffset: start)
            let data = try handle.read(upToCount: Int(logReadLimit)) ?? Data()
            let decoded = String(data: data, encoding: .utf8)
                ?? String(decoding: data, as: UTF8.self)
            var lines = decoded.split(separator: "\n", omittingEmptySubsequences: false)
            if start > 0, !lines.isEmpty { lines.removeFirst() }
            if lines.last?.isEmpty == true { lines.removeLast() }
            return lines.suffix(500).map { line in
                line.last == "\r" ? String(line.dropLast()) : String(line)
            }.joined(separator: "\n")
        } catch {
            return missingMessage
        }
    }

    @objc private func searchEnabledChanged(_ sender: NSButton) {
        SharedSettings.searchEnabled = sender.state == .on
        // The hub reads this file when it starts a sweep, so the change takes
        // effect on its own; the status line is what tells the user that.
        refreshSearchStatus()
    }

    // Index progress, polled while the window is open. A first build over a
    // large corpus takes minutes, and a settings pane that says nothing during
    // it reads as a broken toggle.
    private func refreshSearchStatus() {
        guard let label = searchStatusLabel else { return }
        if !SharedSettings.searchEnabled {
            label.stringValue = "Off. No transcripts are read and no index is kept."
            return
        }
        guard let provider = searchStatusProvider else {
            label.stringValue = "Waiting for the hub."
            return
        }
        Task { @MainActor in
            guard let status = await provider() else {
                label.stringValue = "Waiting for the hub."
                return
            }
            let size = ByteCountFormatter.string(
                fromByteCount: Int64(status.indexSizeBytes), countStyle: .file
            )
            if status.filesPending > 0 {
                let verb = status.firstBuildInProgress ? "Building" : "Updating"
                label.stringValue =
                    "\(verb): \(status.turnsIndexed) messages from "
                    + "\(status.filesKnown) sessions, \(status.filesPending) to go."
            } else {
                label.stringValue =
                    "Ready: \(status.turnsIndexed) messages from "
                    + "\(status.filesKnown) sessions, \(size)."
            }
        }
    }

    @objc private func clearEndsChanged(_ sender: NSButton) {
        SharedSettings.claudeClearEnds = sender.state == .on
    }

    @objc private func codexClearEndsChanged(_ sender: NSButton) {
        SharedSettings.codexClearEnds = sender.state == .on
    }

    @objc private func codexRenameTitleChanged(_ sender: NSButton) {
        SharedSettings.codexRenameTitle = sender.state == .on
    }

    // "<short> (<build>)" from the bundle, e.g. "0.1.4 (42)". A released build
    // is stamped by the release pipeline; a dev build shows the Info.plist
    // placeholder.
    static func appVersion() -> String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }

    @objc private func renameTitleChanged(_ sender: NSButton) {
        SharedSettings.claudeRenameTitle = sender.state == .on
    }

    @objc private func hubModeChanged(_ sender: NSPopUpButton) {
        guard Self.offeredHubModes.indices.contains(sender.indexOfSelectedItem) else { return }
        invalidateRemoteTest()
        selectedMode = Self.offeredHubModes[sender.indexOfSelectedItem]
        renderModeSelection()
    }

    private func renderModeSelection() {
        hubModePopup?.selectItem(at: Self.offeredHubModes.firstIndex(of: selectedMode) ?? 0)
        switch selectedMode {
        case .local, .other:
            modeCaption?.stringValue =
                "The hub runs on this machine and only this machine can reach it."
        case .lan:
            modeCaption?.stringValue =
                "The hub runs on this machine and is open on your local network so "
                + "your phone can connect to it."
        case .remote:
            modeCaption?.stringValue =
                "The hub on your machine forwards to a remote hub. A remote hub can "
                + "accept forwards from many machines at once."
        }
        topology?.mode = selectedMode
        renderModeControls()
        renderConfirmRow()
        resizeHubPaneIfVisible()
    }

    private func renderModeControls() {
        guard let container = modeControlsContainer else { return }
        // Selecting another mode tears these fields down, so what was typed
        // into them is held here: only Confirm persists an address, and a look
        // at another mode must not cost the one being typed.
        if let field = remoteURLField { remoteURLDraft = field.stringValue }
        if let field = remoteTokenField { remoteTokenDraft = field.stringValue }
        container.subviews.forEach { $0.removeFromSuperview() }
        remoteURLField = nil
        remoteTokenField = nil
        testLine = nil

        let content: NSView?
        switch selectedMode {
        case .local, .other:
            content = nil
        case .lan:
            // Pairing hands a device the running hub's LAN address and bearer,
            // so it cannot be offered against a LAN mode that is still only a
            // selection - the hub is still on loopback until Confirm.
            let pair = NSButton(
                title: "Pair a device...",
                target: self,
                action: #selector(pairDevice)
            )
            pair.isEnabled = !pending
            if pending {
                pair.toolTip =
                    "Confirm LAN first. Pairing needs the hub already running in LAN mode."
            }
            content = pair
        case .remote:
            content = remoteModeControls()
        }
        install(content, in: container)
    }

    private func remoteModeControls() -> NSView {
        let urlLabel = rowLabel("Remote hub URL:")
        urlLabel.font = .systemFont(ofSize: 12)
        urlLabel.widthAnchor.constraint(equalToConstant: 104).isActive = true
        let urlField = NSTextField(string: remoteURLDraft ?? SharedSettings.hubRemoteURL)
        urlField.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        urlField.delegate = self
        urlField.widthAnchor.constraint(equalToConstant: 260).isActive = true
        remoteURLField = urlField
        let urlRow = horizontalRow([urlLabel, urlField])

        let tokenLabel = rowLabel("Token:")
        tokenLabel.font = .systemFont(ofSize: 12)
        tokenLabel.widthAnchor.constraint(equalToConstant: 104).isActive = true
        let tokenField = NSSecureTextField(string: remoteTokenDraft ?? SharedSettings.hubToken)
        tokenField.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        tokenField.delegate = self
        tokenField.widthAnchor.constraint(equalToConstant: 260).isActive = true
        remoteTokenField = tokenField
        let testButton = NSButton(
            title: "Test",
            target: self,
            action: #selector(testRemoteHub)
        )
        let tokenRow = horizontalRow([tokenLabel, tokenField, testButton])

        let testLine = NSTextField(labelWithString: "")
        testLine.font = .systemFont(ofSize: 11)
        testLine.textColor = .secondaryLabelColor
        testLine.heightAnchor.constraint(equalToConstant: 16).isActive = true
        self.testLine = testLine

        let stack = verticalStack([urlRow, tokenRow, testLine])
        stack.setCustomSpacing(4, after: urlRow)
        stack.setCustomSpacing(7, after: tokenRow)
        return stack
    }

    private func renderConfirmRow() {
        guard let container = confirmButtonsContainer else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        pendingHintRow?.isHidden = !pending
        guard pending else { return }

        let needsTest = selectedMode == .remote && !testPassed
        let confirm = NSButton(
            title: "Confirm",
            target: self,
            action: #selector(confirmModeChange)
        )
        confirm.keyEquivalent = "\r"
        confirm.isEnabled = !needsTest
        let cancel = NSButton(
            title: "Cancel",
            target: self,
            action: #selector(cancelModeChange)
        )
        install(horizontalRow([confirm, cancel]), in: container)

        pendingHint?.stringValue = needsTest
            ? "Test the address before confirming."
            : "Confirming restarts the hub."
    }

    private func install(_ content: NSView?, in container: NSView) {
        guard let content else { return }
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.topAnchor),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            content.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }

    private func resizeHubPaneIfVisible() {
        guard window != nil, selectedTab == .hub else { return }
        select(tab: .hub)
    }

    @objc private func pairDevice() {
        onPairDevice()
    }

    private enum RemoteTestResult {
        case reached(version: String)
        case rejectedToken
        case noAnswer
    }

    @objc private func testRemoteHub() {
        remoteTestTask?.cancel()
        remoteTestTask = nil
        testPassed = false
        setTestLine("Testing the address.", color: .secondaryLabelColor)
        renderConfirmRow()

        guard let rawURL = remoteURLField?.stringValue,
              let remote = Self.normalizedRemoteURL(rawURL)
        else {
            setTestResult(.noAnswer)
            return
        }
        let token = remoteTokenField?.stringValue ?? ""
        remoteTestTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.performRemoteTest(url: remote.url, token: token)
            guard !Task.isCancelled,
                  self.selectedMode == .remote,
                  Self.normalizedRemoteURL(self.remoteURLField?.stringValue ?? "")?.value
                    == remote.value,
                  self.remoteTokenField?.stringValue == token
            else { return }
            self.remoteTestTask = nil
            self.setTestResult(result)
        }
    }

    private func performRemoteTest(url: URL, token: String) async -> RemoteTestResult {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        var healthRequest = URLRequest(url: url.appendingPathComponent("healthz"))
        healthRequest.httpMethod = "GET"
        let health: HubHealth
        do {
            let (data, response) = try await session.data(for: healthRequest)
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let decoded = try? JSONDecoder().decode(HubHealth.self, from: data),
                  decoded.ok
            else { return .noAnswer }
            health = decoded
        } catch {
            return .noAnswer
        }

        var stateRequest = URLRequest(url: url.appendingPathComponent("state"))
        stateRequest.httpMethod = "GET"
        stateRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // /healthz is unauthenticated by design, so answering it proves nothing
        // about the credential the forwarder will actually use.
        do {
            let (_, response) = try await session.data(for: stateRequest)
            guard let http = response as? HTTPURLResponse else { return .noAnswer }
            switch http.statusCode {
            case 200:
                return .reached(version: health.version ?? "unknown")
            case 401, 403:
                return .rejectedToken
            default:
                return .noAnswer
            }
        } catch {
            return .noAnswer
        }
    }

    private func setTestResult(_ result: RemoteTestResult) {
        switch result {
        case .reached(let version):
            testPassed = true
            setTestLine(
                "Reached the hub. It is running signalbox \(version).",
                color: .systemGreen
            )
        case .rejectedToken:
            testPassed = false
            setTestLine("The hub rejected the token.", color: .systemOrange)
        case .noAnswer:
            testPassed = false
            setTestLine("No answer from that address.", color: .systemOrange)
        }
        renderConfirmRow()
    }

    private func setTestLine(_ text: String, color: NSColor) {
        testLine?.stringValue = text
        testLine?.textColor = color
    }

    private func invalidateRemoteTest() {
        remoteTestTask?.cancel()
        remoteTestTask = nil
        testPassed = false
        setTestLine("", color: .secondaryLabelColor)
    }

    private static func normalizedRemoteURL(_ raw: String) -> (url: URL, value: String)? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty
        else { return nil }
        return (url, value)
    }

    @objc private func confirmModeChange() {
        guard pending else { return }
        let confirmedMode = selectedMode
        switch confirmedMode {
        case .local:
            SharedSettings.applyLocalMode()
        case .lan:
            SharedSettings.applyLANMode()
        case .remote:
            guard testPassed,
                  let remote = Self.normalizedRemoteURL(remoteURLField?.stringValue ?? "")
            else { return }
            SharedSettings.applyRemoteMode(
                upstream: remote.value,
                token: remoteTokenField?.stringValue ?? ""
            )
        case .other:
            return
        }

        monitor.noteRestart()
        Task { [weak self] in
            guard let self else { return }
            await self.restartHub()
            // This only keeps the popup on the confirmed choice while the hub
            // restarts. The pill keeps rendering /healthz and a later answer
            // wins if the process reports a different mode.
            self.runningMode = confirmedMode
            self.invalidateRemoteTest()
            self.renderModeSelection()
        }
    }

    @objc private func cancelModeChange() {
        invalidateRemoteTest()
        selectedMode = runningMode
        renderModeSelection()
    }

    private func applyHealth() {
        let status = HubStatus(
            health: monitor.health,
            lastGood: monitor.lastGood,
            intentMode: SharedSettings.intentMode,
            isStarting: monitor.isStarting,
            lanIP: LANAddress.primary()
        )
        renderPill(status)

        let hadPendingSelection = pending
        if monitor.health != nil {
            runningMode = status.mode == .other ? SharedSettings.intentMode : status.mode
        }
        if !hadPendingSelection, selectedMode != runningMode {
            invalidateRemoteTest()
            selectedMode = runningMode
            renderModeSelection()
        } else if hadPendingSelection, !pending {
            // The running hub caught up with the selection on its own, so the
            // controls that only exist while a change is pending - Confirm and
            // the gated Pair button - have to clear with it.
            renderModeSelection()
        }

        if let version = monitor.health?.version, !version.isEmpty {
            versionLabel?.stringValue = "Signalbox \(Self.appVersion()) - hub \(version)"
        } else {
            versionLabel?.stringValue = "Signalbox \(Self.appVersion())"
        }
    }

    private func renderPill(_ status: HubStatus) {
        let color: NSColor
        switch status.condition {
        case .healthy: color = .systemGreen
        case .warning: color = .systemOrange
        case .starting: color = .secondaryLabelColor
        }
        statusDot?.layer?.backgroundColor = color.cgColor
        statusPill?.layer?.borderColor = (
            status.condition == .warning
                ? NSColor.systemOrange.withAlphaComponent(0.28)
                : NSColor.separatorColor.withAlphaComponent(0.45)
        ).cgColor

        let font = NSFont.systemFont(ofSize: 12)
        let text = NSMutableAttributedString(
            string: "\(status.mode.rawValue) - ",
            attributes: [.font: font, .foregroundColor: NSColor.labelColor]
        )
        text.append(NSAttributedString(
            string: status.address,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
                .foregroundColor: NSColor.labelColor,
            ]
        ))
        if !status.suffix.isEmpty {
            text.append(NSAttributedString(
                string: status.suffix,
                attributes: [.font: font, .foregroundColor: NSColor.systemOrange]
            ))
        }
        statusPillLabel?.attributedStringValue = text
    }

    // Persist live - on every keystroke, and on ⏎ - so the filter applies
    // without a Save button and without depending on the field committing
    // before the jumplist is opened by its global hotkey. Stored as typed
    // (space-separated tags); the reader splits, trims, tolerates a leading `#`.
    private func persistFilter(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespaces)
        if value.isEmpty { UserDefaults.standard.removeObject(forKey: Self.tagFilterKey) }
        else { UserDefaults.standard.set(value, forKey: Self.tagFilterKey) }
        onFilterChange()
    }

    @objc private func filterChanged(_ sender: NSTextField) {
        persistFilter(sender.stringValue)
    }

    func controlTextDidChange(_ note: Notification) {
        guard let field = note.object as? NSTextField else { return }
        if field === remoteURLField || field === remoteTokenField {
            invalidateRemoteTest()
            renderConfirmRow()
            return
        }
        guard field === filterField else { return }
        // During editing the committed stringValue lags; read the field editor.
        let live = (note.userInfo?["NSFieldEditor"] as? NSText)?.string ?? field.stringValue
        persistFilter(live)
    }

    @objc private func iconStyleChanged(_ sender: NSPopUpButton) {
        guard let raw = sender.selectedItem?.representedObject as? String,
              let style = MenuBarIconStyle(rawValue: raw) else { return }
        UserDefaults.standard.set(style.rawValue, forKey: MenuBarIconStyle.defaultsKey)
        onIconChange()
    }
}
