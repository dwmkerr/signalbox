import AppKit

/// Shares foreground policy across the jumplist and ordinary app windows.
@MainActor
enum WindowPresentation {
    static func show(_ window: NSWindow, activateApp: Bool = false) {
        if RuntimeConfiguration.current.foreground {
            if activateApp { NSApp.activate(ignoringOtherApps: true) }
            window.makeKeyAndOrderFront(nil)
            if activateApp { window.orderFrontRegardless() }
        } else {
            // Ordering behind existing windows gives screencapture a rendered
            // window without covering the user's work or receiving their clicks.
            window.level = .normal
            window.hidesOnDeactivate = false
            window.ignoresMouseEvents = true
            window.orderBack(nil)
        }
    }
}
