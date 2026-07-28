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
    // The saved hub address, the same binding Settings drives. The board reads it
    // so its empty state agrees with Settings: a hub we set up but cannot reach is
    // "offline", not the cold "never paired" pitch. One truth, two surfaces.
    @Binding var hubURL: String
    @State private var expanded: String?
    @State private var pressed: String?
    @State private var query = ""
    @State private var confirmDisconnect = false
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
                    // A cached board on an unreachable hub is a memory, and the
                    // faint connection dot alone did not say so. This banner does,
                    // and carries the way back - Reconnect, Scan, Disconnect - so
                    // the fix is where the problem is, not buried in Settings.
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if let kind = offlineBannerKind { offlineBanner(kind) }
                    }
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
            // Same destructive Disconnect as Settings, behind the same confirm:
            // it deletes the token, so it says so before it acts.
            .confirmationDialog(
                "Disconnect from this hub?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) { disconnect() }
            } message: {
                Text("This removes the hub. Scan or enter it again to reconnect.")
            }
            .overlay(alignment: .bottom) { JumpToast(feedback: hub.jumpFeedback) }
        }
    }

    // Three kinds of empty, and the board says which. Live with nothing running
    // is the quiet moon - wait for an agent. A hub we set up but cannot reach is
    // offline: the board is a memory, and the way back is Reconnect / Scan /
    // Disconnect, matching what Settings shows. Only a hub we never set up gets
    // the cold first-run pitch - anything else reads "you were never paired" and
    // that is the bug where the board and Settings disagreed on reload.
    @ViewBuilder
    private var emptyState: some View {
        if isLive {
            ContentUnavailableView(
                "No sessions",
                systemImage: "moon.zzz",
                description: Text("Nothing is running. Fire an agent and it appears here.")
            )
        } else if isConfigured {
            offlineState
        } else {
            notConnectedState
        }
    }

    // Paired, but the hub is not answering right now. Rejected is split out: a
    // retry with the same token just fails again, so it leads with re-pairing
    // rather than a Reconnect that cannot succeed.
    @ViewBuilder
    private var offlineState: some View {
        let host = hub.config.url.host ?? "the hub"
        switch hub.connection {
        case .connecting:
            ContentUnavailableView {
                Label("Connecting...", systemImage: "antenna.radiowaves.left.and.right")
            } description: {
                Text("Reaching \(host).")
            }
        case .rejected:
            ContentUnavailableView {
                Label("Hub rejected this device", systemImage: "lock.trianglebadge.exclamationmark")
            } description: {
                Text("The token is no longer good. Scan the hub's QR again to re-pair.")
            } actions: {
                scanButton("Scan to Re-pair", prominent: true)
                disconnectButton
            }
        default: // .offline
            ContentUnavailableView {
                Label("Hub offline", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                // A phone reaches the hub over the LAN; a corporate/guest network
                // that isolates devices makes this fail with nothing to show, so
                // name the likely cause and the two ways out. The docs link is the
                // repo page (Pages publishes only hero + specs, not docs/*.md).
                Text("Can't reach hub at \(host). Some corporate networks will block device to device connections. Deploy a remote hub, or connect via a mobile hotspot ([see docs](https://github.com/dwmkerr/signalbox/blob/main/docs/mobile.md#corporate-networks)).")
                    .tint(Theme.blue)
            } actions: {
                // hub.start() cancels the backoff wait and retries now, rather
                // than leaving the user to wait out the loop's own timer.
                Button { hub.start() } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.blue)
                scanButton("Scan a New Hub", prominent: false)
                disconnectButton
            }
        }
    }

    // A hub we never set up. Power users pair from the desktop app or the CLI, so
    // the words name only those two ways in - pointing at Settings just sends them
    // to a screen that says the same thing. The scan button is the one-tap path.
    private var notConnectedState: some View {
        ContentUnavailableView {
            Label("Not connected", systemImage: "antenna.radiowaves.left.and.right.slash")
        } description: {
            Text("Choose 'Connect Phone' on the desktop app, or run 'signalbox pair' from the CLI.")
        } actions: {
            scanButton("Scan to Connect", prominent: true)
        }
    }

    private func scanButton(_ title: String, prominent: Bool) -> some View {
        Button {
            showPairSheet = true
        } label: {
            Label(title, systemImage: "qrcode.viewfinder")
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .tint(prominent ? Theme.blue : Theme.faint)
    }

    private var disconnectButton: some View {
        Button("Disconnect", role: .destructive) { confirmDisconnect = true }
    }

    // Forget the hub: the same three steps Settings runs, kept in step so a
    // Disconnect from either surface leaves the same clean state.
    private func disconnect() {
        Keychain.delete(Keychain.hubTokenAccount)
        hubURL = ""
        hub.disconnect()
    }

    private var isLive: Bool {
        if case .live = hub.connection { return true }
        return false
    }

    // Configured means a hub address is saved - the same test Settings uses to
    // choose its connected face.
    private var isConfigured: Bool { !hubURL.isEmpty }

    private enum OfflineBanner { case offline, rejected }

    // The banner shows only when the board has cards to sit above: an empty board
    // gets the full offlineState screen instead. Connecting is transient, so it
    // stays with the quiet connection dot rather than flashing a banner.
    private var offlineBannerKind: OfflineBanner? {
        guard isConfigured, !hub.sessions.isEmpty else { return nil }
        switch hub.connection {
        case .offline: return .offline
        case .rejected: return .rejected
        default: return nil
        }
    }

    private func offlineBanner(_ kind: OfflineBanner) -> some View {
        let host = hub.config.url.host ?? "the hub"
        return HStack(spacing: 10) {
            Image(systemName: kind == .rejected ? "lock.trianglebadge.exclamationmark" : "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 16))
                .foregroundStyle(Theme.amber)
            VStack(alignment: .leading, spacing: 1) {
                Text(kind == .rejected ? "Hub rejected this device" : "Hub offline")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text(kind == .rejected ? "The token is no longer good - re-pair." : "Can't reach \(host). This is the last board we saw.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            // Reconnect retries now (skipping the backoff wait); rejected cannot
            // be fixed by a retry, so it leads with re-pairing in the menu.
            if kind == .offline {
                Button { hub.start() } label: {
                    Text("Reconnect")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.blue)
                }
                .buttonStyle(.plain)
            }
            Menu {
                Button { showPairSheet = true } label: {
                    Label(kind == .rejected ? "Scan to Re-pair" : "Scan a New Hub", systemImage: "qrcode.viewfinder")
                }
                Button(role: .destructive) { confirmDisconnect = true } label: {
                    Label("Disconnect", systemImage: "wifi.slash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.dim)
                    .frame(width: 30, height: 30)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.amber.opacity(0.14))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.amber.opacity(0.3)).frame(height: 0.5) }
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
