import Foundation

/// Verify literal input, refusal states, and asynchronous draft ownership without a terminal.
@main
struct ChatChecks {
    @MainActor
    static func main() async {
        for text in ["hello", "café 👋\n$HOME `code`\t", String(repeating: "x", count: 8192)] {
            precondition(validChatText(text))
        }
        for text in ["  \n", "hello\u{1b}[31m", "\r", String(repeating: "👋", count: 4097)] {
            precondition(!validChatText(text))
        }
        func target(agent: String = "codex", event: String = "done", stopped: Bool = false,
                    child: Bool = false, tmux: Bool = true, machine: String? = "machine") -> ChatSession {
            ChatSession(key: "codex:thread", agent: agent, host: "mac", machine: machine,
                        event: event, stopped: stopped, child: child, hasTmux: tmux)
        }
        precondition(target().unavailable == nil)
        precondition(target(agent: "vscode/claude").unavailable == nil)
        for session in [target(event: "busy"), target(event: "attention"), target(stopped: true),
                        target(child: true), target(tmux: false), target(machine: nil), target(agent: "github")] {
            precondition(session.unavailable != nil)
        }
        let drafts = ChatDrafts()
        drafts.text["a"] = "Send from A"
        drafts.text["b"] = "Keep B"
        var continuation: CheckedContinuation<ChatReceipt, Never>?
        var deliveries = 0
        let task = Task { @MainActor in
            await drafts.send(key: "a") { text in
                deliveries += 1
                precondition(text == "Send from A")
                return await withCheckedContinuation { continuation = $0 }
            }
        }
        while continuation == nil { await Task.yield() }
        precondition(drafts.sending.contains("a"))
        await drafts.send(key: "a") { _ in preconditionFailure("Duplicate send") }
        continuation?.resume(returning: ChatReceipt(id: "receipt", status: "sent", message: "Sent to terminal"))
        await task.value
        precondition(deliveries == 1 && drafts.text["a"] == "" && drafts.text["b"] == "Keep B")
        precondition(drafts.receipts["a"]?.status == "sent" && drafts.sending.isEmpty)
        for status in ["failed", "unknown"] {
            await drafts.send(key: "b") { _ in ChatReceipt(id: "receipt", status: status, message: "Check terminal") }
            precondition(drafts.text["b"] == "Keep B")
        }
        await drafts.send(key: "b") { _ in
            drafts.text["b"] = "Newer draft"
            return ChatReceipt(id: "receipt", status: "sent", message: "Sent to terminal")
        }
        precondition(drafts.text["b"] == "Newer draft")
        print("22 chat input, availability, duplicate-send and draft ownership checks passed")
    }
}
