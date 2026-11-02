import AppKit

/// Multiline input keeps editing keys local to the composer instead of navigating the board.
@MainActor
final class ChatTextView: NSTextView {
    var onSend: (() -> Void)?
    var onEscape: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty else { return }
        let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0),
                             y: textContainerInset.height)
        ("Message  ⌘L" as NSString).draw(at: origin, withAttributes: [
            .font: font ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.placeholderTextColor,
        ])
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if (event.keyCode == 36 || event.keyCode == 76), flags == .command {
            onSend?()
        } else if event.keyCode == 53 {
            onEscape?()
        } else {
            super.keyDown(with: event)
        }
    }
}

/// In-panel chat controls. Input uses the hub so local and forwarded sessions behave alike.
@MainActor
final class ChatComposer: NSView, NSTextViewDelegate {
    let editor = ChatTextView()
    private let drafts: ChatDrafts
    private let status = NSTextField(wrappingLabelWithString: "")
    private let sendButton = NSButton(title: "Send ⌘↩", target: nil, action: nil)
    private let helpButton = NSButton(title: "Set up tmux", target: nil, action: nil)
    private var key: String?
    private var agent = ""
    private var unavailable: String?
    private var helpPopover: NSPopover?
    var onSend: ((String, String) async -> ChatReceipt)?
    var onEscape: (() -> Void)?

    init(drafts: ChatDrafts, scale: CGFloat) {
        self.drafts = drafts
        super.init(frame: .zero)
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.font = .monospacedSystemFont(ofSize: 12 * scale, weight: .regular)
        editor.textColor = .labelColor
        editor.backgroundColor = NSColor(white: 0.12, alpha: 1)
        editor.insertionPointColor = .labelColor
        editor.textContainerInset = NSSize(width: 7 * scale, height: 7 * scale)
        editor.isHorizontallyResizable = false
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.delegate = self
        editor.setAccessibilityIdentifier("chat-message")
        editor.setAccessibilityLabel("Message")
        editor.toolTip = "Command-L focuses this message box. Return inserts a newline. Command-Return sends. Escape returns to search."
        editor.onSend = { [weak self] in self?.send() }
        editor.onEscape = { [weak self] in self?.onEscape?() }

        let scroll = NSScrollView()
        scroll.documentView = editor
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 7 * scale

        status.font = .systemFont(ofSize: 10.5 * scale)
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("chat-delivery-status")
        helpButton.isBordered = false
        helpButton.contentTintColor = .systemBlue
        helpButton.font = .systemFont(ofSize: 10.5 * scale)
        helpButton.target = self
        helpButton.action = #selector(showHelp)
        helpButton.setAccessibilityIdentifier("mobile-chat-help")
        sendButton.bezelStyle = .rounded
        sendButton.font = .systemFont(ofSize: 11 * scale)
        sendButton.target = self
        sendButton.action = #selector(send)
        sendButton.setAccessibilityIdentifier("chat-send")

        let controls = NSStackView(views: [helpButton, NSView(), sendButton])
        controls.orientation = .horizontal
        controls.distribution = .fill
        let stack = NSStackView(views: [status, scroll, controls])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4 * scale
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        for view in [status, scroll, controls] {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 54 * scale),
        ])
        drafts.changed = { [weak self] in self?.refresh() }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var isEditing: Bool { window?.firstResponder === editor }

    func focus() {
        guard key != nil, editor.isEditable else { return }
        window?.makeFirstResponder(editor)
    }

    func display(key: String?, agent: String = "", unavailable: String? = nil) {
        self.key = key
        self.agent = agent
        self.unavailable = unavailable
        isHidden = key == nil
        refresh()
    }

    private func refresh() {
        guard let key else { return }
        let draft = drafts.text[key] ?? ""
        if editor.string != draft { editor.string = draft }
        editor.needsDisplay = true
        let sending = drafts.sending.contains(key)
        // Keep the field focused during a send so subsequent editing keys cannot hit the board.
        editor.isEditable = !sending && unavailable == nil
        sendButton.isEnabled = !sending && unavailable == nil && validChatText(draft)
        sendButton.title = sending ? "Sending…" : "Send ⌘↩"
        let receipt = drafts.receipts[key]
        let validation = draft.utf16.count > 8192 ? "Keep messages under 8,192 characters." : nil
        status.stringValue = unavailable ?? validation ?? receipt?.message ?? ""
        status.isHidden = status.stringValue.isEmpty
        status.textColor = receipt != nil && receipt?.status != "sent" ? .systemOrange : .secondaryLabelColor
    }

    func textDidChange(_ notification: Notification) {
        guard let key else { return }
        drafts.text[key] = editor.string
        refresh()
    }

    @objc private func send() {
        guard sendButton.isEnabled, let key, let onSend else { return }
        Task { await drafts.send(key: key) { text in await onSend(key, text) } }
    }

    @objc private func showHelp() {
        let codex = agent.split(separator: "/").last == "codex"
        let nativeID = String((key ?? "").split(separator: ":", maxSplits: 1).last ?? "")
        let id = UUID(uuidString: nativeID) == nil ? "<session-id>" : nativeID
        let launch = codex ? "codex --no-daemon" : "claude"
        let resume = codex ? "codex --no-daemon resume \(id)" : "claude --resume \(id)"
        let text = NSTextField(wrappingLabelWithString: """
        Chat through tmux

        Signalbox pastes your message into the agent's tmux pane and presses Enter. The session link makes sure the message reaches the conversation you selected.

        1. In your project directory, start tmux:
        tmux new -s mobile-chat

        2. Start your coding agent:
        \(launch)

        For an existing conversation, finish its task and exit the agent first, then resume inside tmux:
        \(resume)

        3. Use the same Signalbox build for the app and CLI hooks. Send one message in the terminal to connect the session, then wait until it is idle.

        4. Leave the terminal's draft empty. Send from this jump box or your phone. Answer permissions and interactive questions in the terminal.

        Codex needs --no-daemon in this spike so Signalbox can verify which pane owns the conversation.
        """)
        text.font = .systemFont(ofSize: 12)
        text.isSelectable = true
        text.translatesAutoresizingMaskIntoConstraints = false
        let controller = NSViewController()
        controller.view = NSView()
        controller.view.addSubview(text)
        NSLayoutConstraint.activate([
            text.widthAnchor.constraint(equalToConstant: 370),
            text.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: 16),
            text.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor, constant: -16),
            text.topAnchor.constraint(equalTo: controller.view.topAnchor, constant: 16),
            text.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor, constant: -16),
        ])
        let popover = NSPopover()
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.show(relativeTo: helpButton.bounds, of: helpButton, preferredEdge: .minY)
        helpPopover = popover
    }
}
