import SwiftUI

/// Setup instructions stay available offline while testing a local build.
struct MobileChatHelp: View {
    let agent: String
    let sessionKey: String
    @Environment(\.dismiss) private var dismiss

    private var launch: String { agent == "codex" ? "codex --no-daemon" : "claude" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Keep your coding session in tmux so Signalbox can send messages to it from your phone.")
                    step("1. Start tmux on your computer", command: "tmux new -s mobile-chat")
                    step("2. Open your project and start the agent", command: launch)
                    Text("For an existing conversation, finish its current task and exit the agent first. Resume it inside tmux:")
                    Text(resumeCommand).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    Text("3. Keep Signalbox running on that computer, with the agent hooks installed. Send one message in the terminal so the session appears on your phone.")
                    Text("4. Open the session on your phone. When the agent is idle, type a message and tap Send.")
                    Text("Keep the terminal's input empty before sending from your phone. This spike sends text to the terminal; answer permission requests and interactive questions on your computer.")
                        .font(.footnote).foregroundStyle(Theme.dim)
                    if agent == "codex" {
                        Text("Use --no-daemon for Codex in this spike. Its shared background process cannot reliably identify which tmux pane owns a conversation.")
                            .font(.footnote).foregroundStyle(Theme.dim)
                    }
                }
                .padding()
            }
            .background(Theme.bg)
            .navigationTitle("Set up mobile chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
    }

    private var resumeCommand: String {
        let id = String(sessionKey.split(separator: ":", maxSplits: 1).last ?? "")
        // Only native UUIDs make a useful, copyable resume command.
        let target = UUID(uuidString: id) == nil ? "<session-id>" : id
        return agent == "codex" ? "codex --no-daemon resume \(target)" : "claude --resume \(target)"
    }

    private func step(_ title: String, command: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
            Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
        }
    }
}
