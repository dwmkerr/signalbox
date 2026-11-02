import AppKit

/// Exercise AppKit's editor behavior with direct events, without activating a window or sending global keys.
@main
struct ChatKeyboardChecks {
    @MainActor
    static func main() {
        _ = NSApplication.shared
        let editor = ChatTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 80))
        // NSTextInputContext needs a first responder even when the window stays offscreen.
        let window = NSWindow(contentRect: editor.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = editor
        window.makeFirstResponder(editor)
        editor.isRichText = false
        var sends = 0, escapes = 0
        editor.onSend = { sends += 1 }
        editor.onEscape = { escapes += 1 }
        func key(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []) {
            editor.keyDown(with: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: 0, windowNumber: 0, context: nil, characters: chars,
                charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!)
        }
        editor.string = "hello"
        editor.setSelectedRange(NSRange(location: 5, length: 0))
        key(36, "\r")
        precondition(editor.string == "hello\n" && sends == 0, "Return must insert a newline")
        key(36, "\r", .command)
        precondition(sends == 1 && editor.string == "hello\n", "Command-Return must send without inserting text")
        key(53, "\u{1b}")
        precondition(escapes == 1, "Escape must leave the composer")
        key(123, "\u{f702}")
        precondition(editor.selectedRange().location == 5, "Arrow keys must edit the message")
        key(48, "\t")
        precondition(editor.string.contains("\t"), "Tab belongs to the editor")
        print("5 AppKit chat keyboard checks passed without global input")
    }
}
