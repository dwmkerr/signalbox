import SwiftUI

// Settings has two faces, following the mock in components/specs/ios.html.
// Not connected: scan a code or enter a hub by hand. Connected: read-only hub
// facts and one Disconnect. Machine and session counts live on the Sessions
// connection line and its pull-to-refresh, so Settings holds only what you set.
struct SettingsView: View {
    @ObservedObject var hub: HubClient
    @Binding var hubURL: String

    @State private var showPairSheet = false
    @State private var showEdit = false
    @State private var confirmDisconnect = false

    // Configured means a hub address is saved. It drives which face shows: a
    // Disconnect on a hub you never set up would be a control with nothing to act on.
    private var isConfigured: Bool { !hubURL.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                if isConfigured { connectedHub } else { notConnectedHub }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .toolbar {
                if isConfigured {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("Edit") { showEdit = true }
                    }
                }
            }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .sheet(isPresented: $showEdit) {
                NavigationStack {
                    HubEntryView(
                        title: "Edit Hub",
                        commitLabel: "Save",
                        showCancel: true,
                        initialURL: hubURL,
                        initialToken: storedToken,
                        onCommit: apply
                    )
                }
            }
        }
    }

    // MARK: - Connected

    @ViewBuilder private var connectedHub: some View {
        Section {
            statusRow
            LabeledContent("Address", value: addressText)
            LabeledContent("Token") { tokenValue }
        } header: {
            Text("Hub")
        } footer: {
            Text("The hub is the machine you connect to that provides your session details.")
        }

        Section {
            // Disconnect deletes the token, so it is destructive - one red action
            // in its own group at the bottom, behind a confirm that says so.
            Button("Disconnect", role: .destructive) { confirmDisconnect = true }
                .confirmationDialog(
                    "Disconnect from this hub?",
                    isPresented: $confirmDisconnect,
                    titleVisibility: .visible
                ) {
                    Button("Disconnect", role: .destructive) { disconnect() }
                } message: {
                    Text("This removes the hub. Scan or enter it again to reconnect.")
                }
        }
    }

    // MARK: - Not connected

    @ViewBuilder private var notConnectedHub: some View {
        Section {
            statusRow
            // Scan leads: one scan fills the address and token and connects.
            Button { showPairSheet = true } label: {
                Label("Scan to Connect", systemImage: "qrcode.viewfinder")
                    .font(.system(size: 15, weight: .semibold))
            }
            // Manual entry sits beneath, pushing to its own screen.
            NavigationLink {
                HubEntryView(
                    title: "Enter Address",
                    commitLabel: "Connect",
                    showCancel: false,
                    initialURL: "",
                    initialToken: "",
                    onCommit: apply
                )
            } label: {
                Text("Enter Address Manually")
            }
        } header: {
            Text("Hub")
        } footer: {
            Text("The hub is the machine you connect to that provides your session details.")
        }
    }

    // MARK: - Rows

    private var statusRow: some View {
        LabeledContent("Status") {
            HStack(spacing: 7) {
                Text(statusText).foregroundStyle(Theme.text)
                Circle().fill(statusColor).frame(width: 8, height: 8)
            }
        }
    }

    // The token is shown as dots when set, the way iOS masks a secure field, and
    // as "Not set" when the hub has no auth. The value itself never appears.
    @ViewBuilder private var tokenValue: some View {
        if storedToken.isEmpty {
            Text("Not set").foregroundStyle(Theme.dim)
        } else {
            Text(String(repeating: "\u{2022}", count: 8))
                .foregroundStyle(Theme.dim)
                .tracking(2)
        }
    }

    private var addressText: String {
        let url = hub.config.url
        if let host = url.host, !host.isEmpty {
            return url.port.map { "\(host):\($0)" } ?? host
        }
        return hubURL
    }

    private var statusColor: Color {
        guard isConfigured else { return Theme.faint }
        switch hub.connection {
        case .live: return Theme.green
        case .connecting: return Theme.amber
        case .offline: return Theme.faint
        case .rejected: return Theme.red
        }
    }

    private var statusText: String {
        guard isConfigured else { return "Not connected" }
        switch hub.connection {
        case .live: return "Connected"
        case .connecting: return "Connecting..."
        case .offline: return "Offline"
        case .rejected: return "Rejected"
        }
    }

    private var storedToken: String {
        Keychain.get(Keychain.hubTokenAccount) ?? ""
    }

    // MARK: - Actions

    private func apply(url: String, token: String) {
        guard let parsed = URL(string: url), parsed.scheme != nil else { return }
        hubURL = url
        Keychain.set(token, account: Keychain.hubTokenAccount)
        // reconfigure no-ops when nothing changed (its own guard), so on an
        // unchanged url+token make sure the loop is running either way.
        if hub.config.url == parsed && (hub.config.token ?? "") == token {
            hub.start()
        } else {
            hub.reconfigure(url: parsed, token: token)
        }
    }

    private func disconnect() {
        Keychain.delete(Keychain.hubTokenAccount)
        hubURL = ""
        hub.disconnect()
    }
}

// The manual hub form, reused for first setup (pushed, commit "Connect") and for
// editing a live hub (a sheet, commit "Save"). Editing is its own mode rather
// than inline fields on the connected screen, matching WireGuard and Pi-hole.
private struct HubEntryView: View {
    let title: String
    let commitLabel: String
    let showCancel: Bool
    let onCommit: (String, String) -> Void

    @State private var url: String
    @State private var token: String
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?

    private enum Field { case url, token }

    init(title: String, commitLabel: String, showCancel: Bool,
         initialURL: String, initialToken: String,
         onCommit: @escaping (String, String) -> Void) {
        self.title = title
        self.commitLabel = commitLabel
        self.showCancel = showCancel
        self.onCommit = onCommit
        _url = State(initialValue: initialURL)
        _token = State(initialValue: initialToken)
    }

    private var valid: Bool {
        guard let parsed = URL(string: url), parsed.scheme != nil else { return false }
        return true
    }

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.20:8377", text: $url)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($focus, equals: .url)
                    .font(.system(size: 13, design: .monospaced))
                // A hub token, not an account password: oneTimeCode stops iOS
                // offering to save it or showing the strong-password overlay.
                SecureField("Token (optional)", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.oneTimeCode)
                    .focused($focus, equals: .token)
                    .font(.system(size: 13, design: .monospaced))
            } header: {
                Text("Hub")
            } footer: {
                Text("Leave the token empty for a hub with no password.")
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .scrollDismissesKeyboard(.immediately)
        .toolbar {
            if showCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(commitLabel) { onCommit(url, token); dismiss() }
                    .disabled(!valid)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }
            }
        }
    }
}
