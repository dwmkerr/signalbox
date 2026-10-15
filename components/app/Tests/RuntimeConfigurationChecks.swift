import Foundation

/// Exercises launch overrides without running AppKit or changing preferences.
@main
struct RuntimeConfigurationChecks {
    static func main() throws {
        let normal = try RuntimeConfiguration(arguments: ["Signalbox"])
        precondition(normal.foreground && !normal.showJumplist)
        let capture = try RuntimeConfiguration(arguments: ["Signalbox", "--config-parameter", "ui.foreground=false", "--show-jumplist"])
        precondition(!capture.foreground && capture.showJumplist)
        let repeated = try RuntimeConfiguration(arguments: ["Signalbox", "--config-parameter=ui.foreground=false", "--config-parameter", "ui.foreground=true"])
        precondition(repeated.foreground, "Last runtime override wins")
        let existing = try RuntimeConfiguration(arguments: ["Signalbox", "--filter", "demo", "--config-parameter", "ui.foreground=false"])
        precondition(!existing.foreground, "Existing launch arguments remain valid")
        for args in [
            ["--config-parameter"], ["--config-parameter", "ui.foreground"],
            ["--config-parameter", "ui.foreground=no"], ["--config-parameter=unknown=false"],
            ["--config-parameter", "--show-jumplist"],
        ] {
            do {
                _ = try RuntimeConfiguration(arguments: ["Signalbox"] + args)
                preconditionFailure("Invalid runtime setting accepted: \(args)")
            } catch {}
        }
        print("9 runtime configuration checks passed")
    }
}
