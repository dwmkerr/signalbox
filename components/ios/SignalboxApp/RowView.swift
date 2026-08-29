import SwiftUI

// The trailing indicator: whether this row wants you. Takes the slot a badge
// occupies in any messaging app, and holds the row's width even when empty so
// titles do not shift as sessions are read.
struct AttentionDot: View {
    let mark: Mark

    var body: some View {
        Circle()
            .fill(mark.attentionDot ?? .clear)
            .frame(width: 9, height: 9)
    }
}

// The state line under the hub name. Never hidden: a remote hub goes offline by
// contract, and a stale board that looks live is the one dangerous failure on
// this surface.
struct ConnectionBar: View {
    let connection: Connection
    let hosts: [String]
    let seq: Int
    // The hub's host, for the "Connected to" line; nil falls back to the
    // plain state label.
    var host: String? = nil

    private var dot: Color {
        switch connection {
        case .live: return Theme.green
        case .connecting: return Theme.amber
        // Amber, not faint grey: offline is a state to notice and act on, and a
        // grey dot read as just another quiet detail (the banner backs this up).
        case .offline: return Theme.amber
        case .rejected: return Theme.red
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(dot).frame(width: 6, height: 6)
            Text(detail)
                .font(.system(size: 11))
                .foregroundStyle(Theme.faint)
                .lineLimit(1)
        }
    }

    private var detail: String {
        guard case .live = connection else { return connection.label }
        let machines = hosts.count == 1 ? "1 machine" : "\(hosts.count) machines"
        guard let host else { return "Live - \(machines) - seq \(seq)" }
        // The heading is the product; where you are connected belongs here.
        return "Connected to \(host) - \(machines)"
    }
}
