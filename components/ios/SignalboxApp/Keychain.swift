import Foundation
import Security

// The hub token is a password, not a preference: it reads every prompt and
// reply across every machine on the hub and can forge events, so it lives in
// the Keychain and never in UserDefaults. See components/specs/ios.html.
//
// Generic-password items need no entitlement (Keychain sharing is a separate
// thing), so this stays dependency-free and works on the simulator and a real
// device alike.
enum Keychain {
    static let service = "com.dwmkerr.signalbox.ios"
    static let hubTokenAccount = "hub-token"

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    static func set(_ value: String, account: String) {
        // Empty means "no token": clear it rather than store a blank that would
        // send an empty Bearer header the hub reads as a failed auth attempt.
        guard !value.isEmpty else { delete(account); return }
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // A foreground reconnect after a lock-and-unlock must still read it,
            // and a future background push will too - but it never leaves the
            // device, so AfterFirstUnlock rather than the more permissive Always.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
