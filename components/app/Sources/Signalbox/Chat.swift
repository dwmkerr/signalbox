import Foundation

/// Routing and availability captured from the selected session, never from its row index.
struct ChatSession {
    /// Stable conversation identity.
    let key: String
    /// Agent display name, possibly prefixed by an editor host.
    let agent: String
    /// Owning host name from the hub.
    let host: String
    /// Stable machine identity required by the executor.
    let machine: String?
    /// Current agent lifecycle state.
    let event: String
    /// Whether the hub confirmed the process stopped.
    let stopped: Bool
    /// Whether this is a worker sharing another session's input.
    let child: Bool
    /// Whether a tmux origin was captured.
    let hasTmux: Bool

    /// Terminal agent family, independent of its editor host.
    var family: String { String(agent.split(separator: "/").last ?? "") }

    /// Current reason to disable input, with final ownership validation left to the executor.
    var unavailable: String? {
        if !["claude", "codex"].contains(family) { return "Chat supports Claude Code and Codex sessions." }
        if child { return "Open the owning session to chat with this agent." }
        if stopped { return "This agent is no longer running." }
        if !hasTmux || machine?.isEmpty != false { return "Run this session inside tmux to send messages from Signalbox." }
        if event == "busy" { return "Wait for this task to finish before sending." }
        if event == "attention" { return "Answer the pending question or permission request in the terminal first." }
        return nil
    }
}

/// Acknowledgement from the computer that attempted input, not proof the model completed it.
struct ChatReceipt: Decodable {
    /// Original command UUID.
    let id: String
    /// Sent, refused before input, or uncertain delivery.
    let status: String
    /// Feedback shown beside the draft.
    let message: String
}

/// The jump box uses the same live-only command and receipt protocol as iOS.
enum ChatClient {
    /// Send once and wait for a correlated execution receipt without automatic retries.
    static func send(_ text: String, to target: ChatSession, hubURL: URL) async -> ChatReceipt {
        let id = UUID().uuidString
        func result(_ status: String, _ message: String) -> ChatReceipt {
            ChatReceipt(id: id, status: status, message: message)
        }
        if let reason = target.unavailable { return result("failed", reason) }
        guard validChatText(text) else { return result("failed", "Use 1 to 8,192 characters without terminal control characters.") }
        var request = HubAuth.request(hubURL.appendingPathComponent("command"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "v": 1, "id": id, "ts": ISO8601DateFormatter().string(from: Date()), "command": "chat",
            "session_key": target.key, "target_host": target.host, "target_machine": target.machine!, "text": text,
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        let network = URLSession(configuration: configuration)
        defer { network.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await network.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return result("unknown", "Delivery was not confirmed. Check the terminal before sending again.")
            }
            if http.statusCode == 401 { return result("failed", "The hub rejected this connection. Check its token in Settings.") }
            if http.statusCode >= 500 { return result("unknown", "The hub could not confirm delivery. Check the terminal before sending again.") }
            guard http.statusCode == 200 else {
                return result("failed", "The hub refused chat. Make sure the computer and hub run the mobile-chat build.")
            }
            guard let receipt = try? JSONDecoder().decode(ChatReceipt.self, from: data), receipt.id == id,
                  ["sent", "failed", "unknown"].contains(receipt.status) else {
                return result("unknown", "Delivery was not confirmed. Check the terminal before sending again.")
            }
            return receipt
        } catch {
            return result("unknown", "Connection lost before delivery was confirmed. Check the terminal before sending again.")
        }
    }
}

/// Match the hub's UTF-16 limit and literal terminal-input policy before offering Send.
func validChatText(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 8192 &&
        !text.unicodeScalars.contains { ($0.value < 32 && $0.value != 9 && $0.value != 10) || $0.value == 127 }
}

/// Drafts and pending sends survive selection changes, panel closure and zoom rebuilds.
@MainActor
final class ChatDrafts {
    /// Unsent text by conversation key.
    var text: [String: String] = [:]
    /// Conversations with an outstanding request.
    private(set) var sending: Set<String> = []
    /// Most recent result for each conversation.
    private(set) var receipts: [String: ChatReceipt] = [:]
    /// Refresh the current view without moving selection.
    var changed: (() -> Void)?

    /// Pin input to its conversation and clear only the unchanged, successfully delivered draft.
    func send(key: String, deliver: @escaping (String) async -> ChatReceipt) async {
        guard !sending.contains(key), let draft = text[key], validChatText(draft) else { return }
        sending.insert(key)
        receipts[key] = nil
        changed?()
        let receipt = await deliver(draft)
        receipts[key] = receipt
        if receipt.status == "sent", text[key] == draft { text[key] = "" }
        sending.remove(key)
        changed?()
    }
}
