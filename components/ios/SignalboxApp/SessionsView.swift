import SwiftUI

// The board on your phone: every session on the hub, live, as cards. One list,
// not two - the split into a browse surface and a jump-pad was a testbed, and a
// day of real use settled it: this card layout is the whole app. A tap expands
// the preview, the leading swipe or the arrow asks the owning machine to jump,
// and the trailing swipe acks or hides.
//
// A List rather than a ScrollView, because swipe actions are a List feature.
// The cards are list rows dressed up.
struct SessionsView: View {
    @ObservedObject var hub: HubClient
    @State private var expanded: String?
    @State private var pressed: String?
    @State private var query = ""
    // The Hidden section starts collapsed and the user opens it. A search
    // overrides this to auto-reveal matches (see hiddenSectionExpanded).
    @State private var hiddenExpanded = false
    // The same main-screen scan affordance every surface carries, presenting the
    // shared PairSheet so pairing is never buried in Settings.
    @State private var showPairSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if hub.sessions.isEmpty {
                    emptyState
                } else {
                    List {
                        ForEach(mainRows) { session in
                            card(session, dimmed: false)
                                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                // Long-press for the pin/unpin menu, the Messages
                                // gesture. The hub owns the partition, so this
                                // only fires an event; it never re-sorts here.
                                .contextMenu { pinMenu(session) }
                                // Only a row with a window to raise offers Jump;
                                // a CI run with a url origin is information, so it
                                // has no jump gesture at all rather than a swipe
                                // that quietly does nothing.
                                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                    if session.jumpable {
                                        Button { jump(session) } label: { Label("Jump", systemImage: "arrow.uturn.forward") }
                                            .tint(Theme.blue)
                                    }
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    // Seen only when it would change something: a
                                    // quiet acked row and a busy row are no-ops, and
                                    // an action that sometimes does nothing teaches
                                    // users to trust none of them. Hide is always on.
                                    if session.isUnread {
                                        Button { Task { await hub.ack(session) } } label: { Label("Seen", systemImage: "checkmark") }
                                            .tint(Theme.amber)
                                    }
                                    Button { Task { await hub.hide(session) } } label: { Label("Hide", systemImage: "eye.slash") }
                                        .tint(Theme.faint)
                                }
                        }

                        // The Hidden divider, always shown (even at "Hidden (0)")
                        // so it is clear whether a session is set aside - a missing
                        // row is otherwise a mystery. Hidden only when nothing at
                        // all matches (the empty/no-matches case).
                        if !mainRows.isEmpty || !hiddenRows.isEmpty {
                            hiddenDivider
                                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)

                            if hiddenSectionExpanded {
                                ForEach(hiddenRows) { session in
                                    card(session, dimmed: true)
                                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                                        .listRowSeparator(.hidden)
                                        .listRowBackground(Color.clear)
                                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                            Button { Task { await hub.unhide(session) } } label: { Label("Unhide", systemImage: "eye") }
                                                .tint(Theme.blue)
                                        }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg)
            .navigationTitle("Signalbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Signalbox").font(.system(size: 16, weight: .bold))
                        ConnectionBar(connection: hub.connection, hosts: hub.hosts, seq: hub.lastSeq, host: hub.config.url.host)
                    }
                }
                ScanToolbarButton { showPairSheet = true }
            }
            // Searching filters name, prompt, reply and agent; a #tag query
            // switches to tag mode. In the drawer so it stays hidden until you
            // pull the list down for it, keeping the board itself uncluttered.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search, or #tag")
            // The escape hatch when a stream has gone strange.
            .refreshable { try? await hub.resyncState() }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .overlay(alignment: .bottom) { JumpToast(feedback: hub.jumpFeedback) }
        }
    }

    // Two different kinds of empty. An empty board on a live hub means nothing is
    // running - wait for an agent. An empty board on a hub we cannot reach means
    // there is nothing to show yet because we are not paired or not connected, so
    // point at the way in rather than implying the board is quiet.
    @ViewBuilder
    private var emptyState: some View {
        if isLive {
            ContentUnavailableView(
                "No sessions",
                systemImage: "moon.zzz",
                description: Text("Nothing is running. Fire an agent and it appears here.")
            )
        } else {
            ContentUnavailableView {
                Label("Not connected", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                Text("Choose 'Connect Phone' from the desktop app, run 'signalbox pair' from the CLI or configure in 'Settings'.")
            } actions: {
                // The hint should not make the user hunt for the toolbar icon:
                // the way in belongs right under the words that name it.
                Button {
                    showPairSheet = true
                } label: {
                    Label("Scan to Connect", systemImage: "qrcode.viewfinder")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.blue)
            }
        }
    }

    private var isLive: Bool {
        if case .live = hub.connection { return true }
        return false
    }

    // A board card. `dimmed` draws a hidden row: faded, an eye-slash where its
    // status mark would be (it is deliberately silenced, so its live status is
    // not the point), and no jump arrow.
    private func card(_ session: Session, dimmed: Bool) -> some View {
        let isOpen = expanded == session.key
        return HStack(spacing: 11) {
            // Tap this area to expand; the jump arrow is its own target.
            HStack(spacing: 11) {
                if dimmed {
                    Image(systemName: "eye.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.faint)
                        .frame(width: 9)
                } else {
                    MarkView(mark: Mark.of(session))
                }
                Image(systemName: agentGlyph(session.agent))
                    .font(.system(size: 15))
                    .foregroundStyle(agentColor(session.agent))
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(session.name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        // A small, quiet pin marks a row kept at the top on
                        // purpose. It reads as "held", not as another status,
                        // so it stays subtle regardless of the row's mark.
                        if session.pinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.amber)
                        }
                        // Which machine the row lives on - but only worth saying
                        // when there is more than one. With one machine every
                        // card names it, which is noise.
                        if hub.hosts.count > 1 {
                            Text(session.host)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(Theme.faint)
                        }
                    }
                    if let preview = subtext(session), !preview.isEmpty {
                        Text(markdownText(preview))
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.dim)
                            .lineLimit(isOpen ? 5 : 1)
                    }
                }
                Spacer(minLength: 4)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeOut(duration: 0.16)) {
                    expanded = isOpen ? nil : session.key
                }
            }

            // The arrow only appears on a row that can be jumped to. A CI run has
            // no machine to raise a window on, so it carries no button to press;
            // a hidden row is silenced, so it does not offer to jump either.
            if session.jumpable && !dimmed {
                Button { jump(session) } label: {
                    Image(systemName: "arrow.uturn.forward")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.blue)
                        .frame(width: 34, height: 34)
                        .background(Theme.blue.opacity(0.12), in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(pressed == session.key ? Theme.blue : Color.white.opacity(0.1),
                              lineWidth: pressed == session.key ? 1.5 : 1)
        )
        .opacity(dimmed ? 0.55 : 1)
    }

    // The pin/unpin context-menu entry. Hiding a pinned session unpins it, so a
    // hidden row is never pinned and this only ever appears on the main list.
    @ViewBuilder
    private func pinMenu(_ session: Session) -> some View {
        if session.pinned {
            Button { Task { await hub.unpin(session) } } label: { Label("Unpin", systemImage: "pin.slash") }
        } else {
            Button { Task { await hub.pin(session) } } label: { Label("Pin", systemImage: "pin") }
        }
    }

    // The quiet divider that gates the Hidden section. Tap toggles it open.
    private var hiddenDivider: some View {
        let empty = hiddenRows.isEmpty
        return HStack(spacing: 6) {
            // No chevron at "Hidden (0)": nothing to expand.
            if !empty {
                Image(systemName: hiddenSectionExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
            }
            Text("Hidden (\(hiddenRows.count))")
                .font(.system(size: 13, weight: .medium))
            Spacer()
        }
        .foregroundStyle(Theme.faint)
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !empty else { return }
            withAnimation(.easeOut(duration: 0.18)) { hiddenExpanded.toggle() }
        }
    }

    private func jump(_ session: Session) {
        pressed = session.key
        Task {
            await hub.jump(session)
            try? await Task.sleep(nanoseconds: 250_000_000)
            pressed = nil
        }
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespaces).lowercased()
    }

    // Filters live over name, prompt, reply and agent; a #tag query switches to
    // exact, case-insensitive tag match. Same rule as the jumplist.
    private func matches(_ session: Session, _ q: String) -> Bool {
        if q.hasPrefix("#") {
            let tag = String(q.dropFirst())
            return session.tags.contains { $0.lowercased() == tag }
        }
        return session.name.lowercased().contains(q)
            || (session.prompt ?? "").lowercased().contains(q)
            || (session.reply ?? "").lowercased().contains(q)
            || session.agent.lowercased().contains(q)
    }

    // The board is the non-hidden rows, in the hub's order, filtered by any
    // query. The hub owns the order and puts pinned rows first, so this never
    // re-sorts.
    private var mainRows: [Session] {
        let q = trimmedQuery
        let visible = hub.sessions.filter { !$0.hidden }
        return q.isEmpty ? visible : visible.filter { matches($0, q) }
    }

    // Behind the divider. With no query, every hidden row; with a query, only
    // the matches, so search sees through the section (the Gmail rule: search
    // includes the archive).
    private var hiddenRows: [Session] {
        let q = trimmedQuery
        let hidden = hub.sessions.filter { $0.hidden }
        return q.isEmpty ? hidden : hidden.filter { matches($0, q) }
    }

    // A query that turns up something hidden auto-reveals the section with the
    // matches in it; otherwise the section obeys the manual toggle.
    private var hiddenSectionExpanded: Bool {
        trimmedQuery.isEmpty ? hiddenExpanded : true
    }
}

// A jump is a request to another machine, so it needs saying out loud: the
// laptop may be asleep, the app may not be running. The row going quiet is the
// real confirmation, but silence needs a voice too.
struct JumpToast: View {
    let feedback: HubClient.JumpFeedback?

    var body: some View {
        if let feedback {
            HStack(spacing: 6) {
                Image(systemName: feedback.ok ? "arrow.uturn.forward" : "exclamationmark.triangle")
                Text(feedback.text)
            }
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(feedback.ok ? Theme.text : Theme.red)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.12)))
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .id(feedback.text)
        }
    }
}
