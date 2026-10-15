import AppKit

// Reject invalid runtime overrides before starting the app or its hub.
_ = RuntimeConfiguration.current

// Delegate is held in a top-level constant because NSApplication.delegate is weak.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
