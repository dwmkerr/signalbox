import SwiftUI

// One board row: status mark, agent glyph, name, host, age, subtext. The same
// anatomy as the jumplist, plus the host chip carrying more weight here -
// on a phone nothing is local, so the machine is what tells you whether the
// row can be acted on at all.
struct RowView: View {
    let session: Session
    var showHost = true

    private var mark: Mark { Mark.of(session) }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            MarkView(mark: mark)
                .padding(.top, 5)
            Image(systemName: agentGlyph(session.agent))
                .font(.system(size: 12))
                .foregroundStyle(agentColor(session.agent))
                .frame(width: 17)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(session.name)
                        .font(.system(size: 14.5, weight: session.isUnread ? .bold : .regular))
                        .foregroundStyle(session.isUnread ? Theme.text : Theme.dim)
                        .lineLimit(1)
                    if showHost { HostChip(host: session.host) }
                    Spacer(minLength: 4)
                    Text(shortAge(session.date))
                        .font(.system(size: 11.5).monospacedDigit())
                        .foregroundStyle(Theme.faint)
                }
                if let text = subtext(session), !text.isEmpty {
                    Text(text)
                        .font(.system(size: 12.5))
                        .foregroundStyle(session.acked ? Theme.faint : Theme.dim)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

struct MarkView: View {
    let mark: Mark

    var body: some View {
        Group {
            switch mark {
            case .working:
                // A spinner, because "working" is the one status that is about
                // time passing rather than a thing that happened.
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.6)
                    .frame(width: 9, height: 9)
            case .failed:
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Theme.red)
                    .frame(width: 9, height: 9)
            case .read:
                Circle()
                    .strokeBorder(Theme.faint.opacity(0.6), lineWidth: 1.5)
                    .frame(width: 9, height: 9)
            case .attention, .unread:
                Circle().fill(mark.color).frame(width: 9, height: 9)
            }
        }
    }
}

struct HostChip: View {
    let host: String

    var body: some View {
        Text(host)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(Theme.dim)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 4))
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
        case .offline: return Theme.faint
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
