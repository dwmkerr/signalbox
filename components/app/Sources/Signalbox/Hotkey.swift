import AppKit
import Carbon

// Carbon RegisterEventHotKey rather than an NSEvent global monitor: it needs
// no accessibility permission prompt and it consumes the keystroke, so the
// frontmost app never sees it - the Spotlight/Raycast summoning mechanism.
@MainActor
final class GlobalHotkey {
    struct Spec {
        let keyCode: UInt32
        let modifiers: UInt32
        let display: String
    }

    // ⌃⌥J. Carbon registrations are first-come-first-served across the whole
    // machine (and success is reported even for contended combos), so a
    // broken user override falls back here rather than failing silently.
    static let defaultSpec = Spec(
        keyCode: UInt32(kVK_ANSI_J),
        modifiers: UInt32(controlKey | optionKey),
        display: "ctrl+alt+j"
    )

    static let fallbackSpec = defaultSpec

    /// Parses "ctrl+alt+j" / "cmd+shift+space" style strings. Returns nil on
    /// anything unrecognised so the caller can log and fall back to the default.
    static func parse(_ raw: String) -> Spec? {
        let tokens = raw.lowercased()
            .split(separator: "+")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard tokens.count >= 2, let keyName = tokens.last else { return nil }
        var modifiers: UInt32 = 0
        for token in tokens.dropLast() {
            switch token {
            case "cmd", "command": modifiers |= UInt32(cmdKey)
            case "ctrl", "control": modifiers |= UInt32(controlKey)
            case "alt", "opt", "option": modifiers |= UInt32(optionKey)
            case "shift": modifiers |= UInt32(shiftKey)
            default: return nil
            }
        }
        // A bare key with no modifier would shadow normal typing system-wide.
        guard modifiers != 0, let keyCode = keyCodes[keyName] else { return nil }
        return Spec(keyCode: keyCode, modifiers: modifiers, display: tokens.joined(separator: "+"))
    }

    private static let keyCodes: [String: UInt32] = [
        "a": UInt32(kVK_ANSI_A), "b": UInt32(kVK_ANSI_B), "c": UInt32(kVK_ANSI_C),
        "d": UInt32(kVK_ANSI_D), "e": UInt32(kVK_ANSI_E), "f": UInt32(kVK_ANSI_F),
        "g": UInt32(kVK_ANSI_G), "h": UInt32(kVK_ANSI_H), "i": UInt32(kVK_ANSI_I),
        "j": UInt32(kVK_ANSI_J), "k": UInt32(kVK_ANSI_K), "l": UInt32(kVK_ANSI_L),
        "m": UInt32(kVK_ANSI_M), "n": UInt32(kVK_ANSI_N), "o": UInt32(kVK_ANSI_O),
        "p": UInt32(kVK_ANSI_P), "q": UInt32(kVK_ANSI_Q), "r": UInt32(kVK_ANSI_R),
        "s": UInt32(kVK_ANSI_S), "t": UInt32(kVK_ANSI_T), "u": UInt32(kVK_ANSI_U),
        "v": UInt32(kVK_ANSI_V), "w": UInt32(kVK_ANSI_W), "x": UInt32(kVK_ANSI_X),
        "y": UInt32(kVK_ANSI_Y), "z": UInt32(kVK_ANSI_Z),
        "0": UInt32(kVK_ANSI_0), "1": UInt32(kVK_ANSI_1), "2": UInt32(kVK_ANSI_2),
        "3": UInt32(kVK_ANSI_3), "4": UInt32(kVK_ANSI_4), "5": UInt32(kVK_ANSI_5),
        "6": UInt32(kVK_ANSI_6), "7": UInt32(kVK_ANSI_7), "8": UInt32(kVK_ANSI_8),
        "9": UInt32(kVK_ANSI_9),
        "space": UInt32(kVK_Space),
        "return": UInt32(kVK_Return), "enter": UInt32(kVK_Return),
        "tab": UInt32(kVK_Tab),
    ]

    private static let signature: OSType = {
        var result: OSType = 0
        for scalar in "SGBX".unicodeScalars { result = (result << 8) + OSType(scalar.value) }
        return result
    }()

    private let spec: Spec
    private let onPress: @MainActor () -> Void
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    init(spec: Spec, onPress: @escaping @MainActor () -> Void) {
        self.spec = spec
        self.onPress = onPress
    }

    private static let hotKeyNumber: UInt32 = 1

    // Returns false when the combo could not be claimed (usually because
    // another app registered it first) so the caller can fall back.
    @discardableResult
    func register() -> Bool {
        // Registering again would orphan the previous Carbon refs (there is no
        // unregister path - see the deinit note below), so refuse a second call.
        guard handlerRef == nil, hotKeyRef == nil else { return hotKeyRef != nil }
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        // The Carbon handler is a C function pointer and cannot capture, so
        // `self` rides along as userData (unretained: this object lives for
        // the app's lifetime in the AppDelegate).
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                // Carbon delivers application-target events on the main
                // thread's run loop, so assuming MainActor is sound here.
                return MainActor.assumeIsolated { () -> OSStatus in
                    // Match our ID so another registration in this process can
                    // never trigger the palette through this handler.
                    var hotKeyID = EventHotKeyID()
                    let status = GetEventParameter(
                        event,
                        EventParamName(kEventParamDirectObject),
                        EventParamType(typeEventHotKeyID),
                        nil,
                        MemoryLayout<EventHotKeyID>.size,
                        nil,
                        &hotKeyID
                    )
                    guard status == noErr,
                          hotKeyID.signature == GlobalHotkey.signature,
                          hotKeyID.id == GlobalHotkey.hotKeyNumber
                    else { return OSStatus(eventNotHandledErr) }
                    let hotkey = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
                    hotkey.onPress()
                    return noErr
                }
            },
            1,
            &eventSpec,
            selfPtr,
            &handlerRef
        )
        guard installStatus == noErr else {
            NSLog("Signalbox: failed to install hotkey handler (status \(installStatus))")
            return false
        }
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: Self.hotKeyNumber)
        let registerStatus = RegisterEventHotKey(
            spec.keyCode,
            spec.modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        if registerStatus != noErr {
            NSLog("Signalbox: failed to register hotkey \(spec.display) (status \(registerStatus))")
            hotKeyRef = nil
            return false
        }
        return true
    }

    // No deinit cleanup: the AppDelegate holds this for the process lifetime
    // and the OS releases Carbon registrations on exit. (A nonisolated deinit
    // also cannot touch the non-Sendable EventHotKeyRef under Swift 6.)
}
