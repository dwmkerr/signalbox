import AgentMarkdown
import SwiftUI

// The session as a conversation: prompts on the right, replies on the left,
// with the agent's Markdown rendered. Both apps share the parsed representation.
// iOS applies its own proportional chat styling.
struct ChatView: View {
    @ObservedObject var hub: HubClient
    let session: Session
    @State private var exchanges: [Exchange] = []
    @State private var loading = false
    @State private var hasMore = false
    @State private var failed = false
    @State private var olderFailed = false

    private let pageLimit = 3

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if failed && exchanges.isEmpty {
                    failureState
                } else if loading && exchanges.isEmpty {
                    ProgressView()
                        .tint(Theme.dim)
                        .frame(maxWidth: .infinity, minHeight: 240)
                } else if exchanges.isEmpty {
                    Text("No history yet")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.dim)
                        .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    if olderFailed {
                        olderFailureButton
                    } else if hasMore {
                        olderButton
                    }
                    ForEach(exchanges) { exchange in
                        exchangeView(exchange)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadInitial() }
    }

    private var olderButton: some View {
        Button { Task { await loadOlder() } } label: {
            VStack(spacing: 0) {
                Text(AgentMarkdown.croppedMarker)
                    .font(.system(size: 19, weight: .semibold))
                Text("older")
                    .font(.system(size: 10))
            }
            .foregroundStyle(Theme.dim)
            .frame(minWidth: 52, minHeight: 38)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .frame(maxWidth: .infinity)
    }

    private var olderFailureButton: some View {
        Button { Task { await loadOlder() } } label: {
            Text("Could not load older - tap to retry")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
                .frame(minHeight: 38)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .frame(maxWidth: .infinity)
    }

    private var failureState: some View {
        VStack(spacing: 10) {
            Text("Could not load the chat")
                .font(.system(size: 14))
                .foregroundStyle(Theme.dim)
            Button("Retry") { Task { await loadInitial() } }
                .buttonStyle(.bordered)
                .tint(Theme.blue)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
    }

    @ViewBuilder
    private func exchangeView(_ exchange: Exchange) -> some View {
        let prompt = nonempty(exchange.prompt)
        let reply = nonempty(exchange.reply)
        VStack(spacing: 10) {
            if let prompt {
                bubble(prompt, exchange: exchange, outgoing: true)
            }
            if let reply {
                bubble(reply, exchange: exchange, outgoing: false)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func bubble(_ text: String, exchange: Exchange, outgoing: Bool) -> some View {
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
            Text(render(text, style: chatStyle, cropped: exchange.cropped))
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(
                    outgoing ? Theme.blue.opacity(0.22) : Theme.card,
                    in: RoundedRectangle(cornerRadius: 16)
                )
            if let date = EventDate.parse(exchange.ts) {
                Text(date.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
            }
        }
        .frame(maxWidth: .infinity, alignment: outgoing ? .trailing : .leading)
        .padding(outgoing ? .leading : .trailing, 60)
    }

    private func nonempty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return text
    }

    private func loadInitial() async {
        guard !loading, exchanges.isEmpty else { return }
        loading = true
        failed = false
        defer { loading = false }
        do {
            let doc = try await hub.exchanges(for: session.key, limit: pageLimit)
            exchanges = doc.exchanges
            hasMore = doc.exchanges.count == pageLimit
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    private func loadOlder() async {
        guard !loading, hasMore, let before = exchanges.first?.seq else { return }
        loading = true
        olderFailed = false
        defer { loading = false }
        do {
            let doc = try await hub.exchanges(for: session.key, limit: pageLimit, before: before)
            exchanges = doc.exchanges + exchanges
            hasMore = doc.exchanges.count == pageLimit
        } catch {
            if !Task.isCancelled { olderFailed = true }
        }
    }
}
