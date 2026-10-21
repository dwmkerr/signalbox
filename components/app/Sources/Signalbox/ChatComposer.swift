import AppKit

/// Multiline input keeps editing keys local to the composer instead of navigating the board.
@MainActor
final class ChatTextView: NSTextView {
    var onSend: (() -> Void)?
    var onEscape: (() -> Void)?

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
    private let helpButton = NSButton(title: "Set up mobile chat", target: nil, action: nil)
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
        editor.font = .systemFont(ofSize: 12 * scale)
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
        editor.toolTip = "Return inserts a newline. Command-Return sends. Escape returns to search."
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
        for view in [status, scroll, controls] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            view.leadingAnchor.constraint(equalTo: leadingAnchor).isActive = true
            view.trailingAnchor.constraint(equalTo: trailingAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: topAnchor),
            scroll.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 5 * scale),
            scroll.heightAnchor.constraint(equalToConstant: 54 * scale),
            controls.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 4 * scale),
            controls.bottomAnchor.constraint(equalTo: bottomAnchor),
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
        let sending = drafts.sending.contains(key)
        // Keep the field focused during a send so subsequent editing keys cannot hit the board.
        editor.isEditable = !sending && unavailable == nil
        sendButton.isEnabled = !sending && unavailable == nil && validChatText(draft)
        sendButton.title = sending ? "Sending…" : "Send ⌘↩"
        let receipt = drafts.receipts[key]
        let validation = draft.utf16.count > 8192 ? "Keep messages under 8,192 characters." : nil
        status.stringValue = unavailable ?? validation ?? receipt?.message ?? "Message · ⌘L to type"
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
        Set up mobile chat

        1. In your project directory, start tmux:
        tmux new -s mobile-chat

        2. Start your coding agent:
        \(launch)

        For an existing conversation, finish its task and exit the agent first, then resume inside tmux:
        \(resume)

        3. Keep Signalbox running with its agent hooks installed. Send one message in the terminal to connect the session, then wait until it is idle.

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
