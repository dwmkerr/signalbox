import AppKit

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

    // Whether the hub is bound so other devices can reach it. hub.bind is stored
    // as a literal address; anything other than a loopback address (or an unset
    // key, which defaults to loopback) means the LAN can reach the hub.
    static var hubAllowsNetworkAccess: Bool {
        let hub = read()["hub"] as? [String: Any]
        guard let bind = hub?["bind"] as? String, !bind.isEmpty else { return false }
        return !isLoopback(bind)
    }

    // Loopback binds only answer this Mac; every other address exposes the hub
    // to other devices on the network.
    private static func isLoopback(_ bind: String) -> Bool {
        ["127.0.0.1", "::1", "localhost", "loopback"].contains(bind.lowercased())
    }

    // Allow other devices to reach the hub: hub.bind = "0.0.0.0" (the wildcard
    // that also keeps loopback served for local hooks and this app), deep-merged
    // so an existing hub.token (and every other key) survives. The user reaches
    // this from Connect Phone or the Settings "Hub" checkbox - never silently.
    // The restarted hub reads this, binds every interface, and mints a token if
    // it has none.
    static func enableNetworkAccess() {
        setHubBind("0.0.0.0")
    }

    // Restrict the hub back to this Mac: hub.bind = "127.0.0.1", deep-merged.
    static func disableNetworkAccess() {
        setHubBind("127.0.0.1")
    }

    private static func setHubBind(_ bind: String) {
        var root = read()
        var hub = root["hub"] as? [String: Any] ?? [:]
        hub["bind"] = bind
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
}

// The Settings window: menu bar icon style and behaviour toggles; future
// prefs (hotkey, notification rules) land here too. Plain AppKit - one
// window, radio buttons, UserDefaults + the shared settings file.
@MainActor
final class SettingsController: NSObject, NSTextFieldDelegate {
    // The board's tag filter, shared with AppDelegate. Kept in UserDefaults
    // (a local view preference, not shared config): set it here to a tag and
    // the jumplist shows only sessions carrying it - the quiet way to flip to
    // `demo` for a recording and back to real work. Blank = all sessions.
    static let tagFilterKey = "tagFilter"

    private let onIconChange: @MainActor () -> Void
    private let onFilterChange: @MainActor () -> Void
    // Same restart path Connect Phone uses: flipping hub access rewrites
    // hub.bind in settings.json, and the hub only picks that up on a restart.
    private let restartHub: @MainActor () async -> Void
    // Only needed for the port shown in the "Devices reach this Mac at ..."
    // caption; the address itself comes from LANAddress.
    private let hubPort: Int
    private var window: NSWindow?
    private var iconPopup: NSPopUpButton?
    private var clearCheckbox: NSButton?
    private var renameCheckbox: NSButton?
    private var codexClearCheckbox: NSButton?
    private var codexRenameCheckbox: NSButton?
    private var filterField: NSTextField?
    private var hubAccessCheckbox: NSButton?
    private var hubCaption: NSTextField?

    init(
        hubURL: URL,
        onIconChange: @escaping @MainActor () -> Void,
        onFilterChange: @escaping @MainActor () -> Void,
        restartHub: @escaping @MainActor () async -> Void
    ) {
        self.hubPort = hubURL.port ?? 8377
        self.onIconChange = onIconChange
        self.onFilterChange = onFilterChange
        self.restartHub = restartHub
        super.init()
    }

    func show() {
        if window == nil { build() }
        // The hub bind can change while this window exists (Connect Phone also
        // writes it), so re-read the live state every time it is shown.
        refreshHubState()
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
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Signalbox Settings"
        window.isReleasedWhenClosed = false
        window.center()

        let heading = NSTextField(labelWithString: "Menu bar icon:")
        heading.font = .systemFont(ofSize: 13)
        heading.textColor = .secondaryLabelColor

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
        let iconRow = NSStackView(views: [heading, popup])
        iconRow.orientation = .horizontal
        iconRow.spacing = 8
        let radioViews: [NSView] = [iconRow]

        let caption = NSTextField(
            wrappingLabelWithString:
                "A colored dot appears on the icon when sessions wait: "
                + "amber = needs your input, blue = output updated, red = failed."
        )
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor

        // Behaviour toggles live in the shared settings file
        // (~/.config/signalbox/settings.json) so the CLI hooks read the same
        // choices the app writes.
        let sessionsHeading = NSTextField(labelWithString: "Sessions")
        sessionsHeading.font = .systemFont(ofSize: 13, weight: .semibold)

        let clearCheckbox = NSButton(
            checkboxWithTitle: "Claude Code /clear removes the session from the board",
            target: self,
            action: #selector(clearEndsChanged(_:))
        )
        clearCheckbox.state = SharedSettings.claudeClearEnds ? .on : .off
        self.clearCheckbox = clearCheckbox

        let clearCaption = NSTextField(
            wrappingLabelWithString:
                "Unchecked, a /clear keeps the old session listed (marked ready) "
                + "until you hide or remove it - the exchange stays reviewable."
        )
        clearCaption.font = .systemFont(ofSize: 11)
        clearCaption.textColor = .secondaryLabelColor

        let renameCheckbox = NSButton(
            checkboxWithTitle: "Rename session on Claude Code /rename",
            target: self,
            action: #selector(renameTitleChanged(_:))
        )
        renameCheckbox.state = SharedSettings.claudeRenameTitle ? .on : .off
        self.renameCheckbox = renameCheckbox

        let renameCaption = NSTextField(
            wrappingLabelWithString:
                "On, a Claude /rename shows on the board as the session name. "
                + "Off keeps the folder name. Your own ⌃R rename always wins either way."
        )
        renameCaption.font = .systemFont(ofSize: 11)
        renameCaption.textColor = .secondaryLabelColor

        // The Codex pair, flat for now - agent-specific settings get their own
        // tabs/tree once a third agent needs toggles.
        let codexClearCheckbox = NSButton(
            checkboxWithTitle: "Codex clear removes the session from the board",
            target: self,
            action: #selector(codexClearEndsChanged(_:))
        )
        codexClearCheckbox.state = SharedSettings.codexClearEnds ? .on : .off
        self.codexClearCheckbox = codexClearCheckbox

        let codexRenameCheckbox = NSButton(
            checkboxWithTitle: "Rename session on Codex /rename",
            target: self,
            action: #selector(codexRenameTitleChanged(_:))
        )
        codexRenameCheckbox.state = SharedSettings.codexRenameTitle ? .on : .off
        self.codexRenameCheckbox = codexRenameCheckbox

        let codexCaption = NSTextField(
            wrappingLabelWithString: "The Codex pair of the two toggles above."
        )
        codexCaption.font = .systemFont(ofSize: 11)
        codexCaption.textColor = .secondaryLabelColor

        let hotkeyCaption = NSTextField(
            wrappingLabelWithString:
                "Jumplist shortcut: ⌃⌥J - override with "
                + "defaults write com.dwmkerr.signalbox hotkey \"cmd+shift+space\""
        )
        hotkeyCaption.font = .systemFont(ofSize: 11)
        hotkeyCaption.textColor = .secondaryLabelColor

        // Hub network access: whether the hub answers only this Mac (loopback)
        // or other devices too. The checkbox writes a literal hub.bind to the
        // shared settings and restarts the hub, the same path Connect Phone
        // uses to pair a phone.
        let hubHeading = NSTextField(labelWithString: "Hub")
        hubHeading.font = .systemFont(ofSize: 13, weight: .semibold)

        let hubAccessCheckbox = NSButton(
            checkboxWithTitle: "Allow other devices to connect (requires token)",
            target: self,
            action: #selector(hubAccessChanged(_:))
        )
        hubAccessCheckbox.state = SharedSettings.hubAllowsNetworkAccess ? .on : .off
        self.hubAccessCheckbox = hubAccessCheckbox

        let hubCaption = NSTextField(wrappingLabelWithString: hubCaptionText())
        hubCaption.font = .systemFont(ofSize: 11)
        hubCaption.textColor = .secondaryLabelColor
        self.hubCaption = hubCaption

        // Additional filters: tags always applied to the board, on top of any
        // search. Space-separated for more than one; the board shows only
        // sessions carrying every tag listed.
        let filterHeading = NSTextField(labelWithString: "Additional filters")
        filterHeading.font = .systemFont(ofSize: 13, weight: .semibold)

        let filterField = NSTextField(string: UserDefaults.standard.string(forKey: Self.tagFilterKey) ?? "")
        filterField.placeholderString = "#tag or name"
        filterField.delegate = self
        filterField.target = self
        filterField.action = #selector(filterChanged(_:))
        filterField.widthAnchor.constraint(equalToConstant: 200).isActive = true
        self.filterField = filterField

        let filterCaption = NSTextField(
            wrappingLabelWithString:
                "Always applied to the jumplist and menu bar. #tag matches a tag, "
                + "plain text matches the session name or its last message, ! excludes - e.g. #work !project "
                + "shows work and hides anything named or tagged project. Blank shows all."
        )
        filterCaption.font = .systemFont(ofSize: 11)
        filterCaption.textColor = .secondaryLabelColor

        let stack = NSStackView(
            views: [heading] + radioViews
                + [caption, sessionsHeading, clearCheckbox, clearCaption,
                   renameCheckbox, renameCaption,
                   codexClearCheckbox, codexRenameCheckbox, codexCaption,
                   hotkeyCaption,
                   hubHeading, hubAccessCheckbox, hubCaption,
                   filterHeading, filterField, filterCaption]
        )
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.setCustomSpacing(16, after: radioViews.last ?? caption)
        stack.setCustomSpacing(20, after: caption)
        stack.setCustomSpacing(16, after: clearCaption)
        stack.setCustomSpacing(16, after: renameCaption)
        stack.setCustomSpacing(16, after: codexCaption)
        stack.setCustomSpacing(20, after: hotkeyCaption)
        stack.setCustomSpacing(4, after: hubHeading)
        stack.setCustomSpacing(20, after: hubCaption)
        stack.setCustomSpacing(4, after: filterHeading)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -20),
        ])
        window.contentView = content
        window.setContentSize(NSSize(width: 400, height: 600))
        self.window = window
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

    // Flip whether the hub answers other devices. hub.bind is only re-read when
    // the hub restarts, so rewrite the file and restart on the same path Connect
    // Phone uses. Off restricts it straight back to this Mac.
    @objc private func hubAccessChanged(_ sender: NSButton) {
        if sender.state == .on {
            SharedSettings.enableNetworkAccess()
        } else {
            SharedSettings.disableNetworkAccess()
        }
        Task { await restartHub() }
    }

    // The reachable address the phone dials: this Mac's LAN IP and the hub port.
    // Falls back to a plain sentence when no LAN address resolves (no Wi-Fi).
    private func hubCaptionText() -> String {
        guard let ip = LANAddress.primary() else {
            return "Devices reach this Mac on port \(hubPort) once it joins Wi-Fi. "
                + "The token is created automatically."
        }
        return "Devices reach this Mac at \(ip):\(hubPort). The token is created automatically."
    }

    // Re-read the live hub state so the checkbox and caption match the file even
    // when Connect Phone changed it while this window was open.
    private func refreshHubState() {
        hubAccessCheckbox?.state = SharedSettings.hubAllowsNetworkAccess ? .on : .off
        hubCaption?.stringValue = hubCaptionText()
    }

    @objc private func renameTitleChanged(_ sender: NSButton) {
        SharedSettings.claudeRenameTitle = sender.state == .on
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
        guard let field = note.object as? NSTextField, field === filterField else { return }
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
