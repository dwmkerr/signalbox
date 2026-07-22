import Darwin
import Foundation

// This Mac's primary LAN IPv4, shared by Connect Phone (the address baked into
// the QR deep link) and Settings (the "Devices reach this Mac at <IP>:<port>"
// caption) so the two never disagree on what address a phone should dial.
enum LANAddress {
    // Skips loopback, link-local, VPN tunnels and Apple peer-to-peer links
    // (utun/tun/ppp/ipsec/awdl/llw) so a tunnel's RFC1918 address never beats
    // the real Wi-Fi one a phone on the same network can reach.
    private static let skipInterfacePrefixes = ["utun", "tun", "ppp", "ipsec", "awdl", "llw"]

    // Prefers en0 (Wi-Fi on a laptop), then any other Ethernet-style interface.
    // A known corp-VPN range (10.17.x) is skipped for the same reason as the
    // tunnel interfaces above.
    static func primary() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }

        var candidates: [(name: String, ip: String)] = []
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0 else { continue }
            guard let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            if skipInterfacePrefixes.contains(where: { name.hasPrefix($0) }) { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST
            ) == 0 else { continue }
            let ip = host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
            if ip.hasPrefix("127.") || ip.hasPrefix("169.254.") || ip.hasPrefix("10.17.") { continue }
            candidates.append((name, ip))
        }
        return candidates.first { $0.name == "en0" }?.ip
            ?? candidates.first { $0.name.hasPrefix("en") }?.ip
            ?? candidates.first?.ip
    }
}
