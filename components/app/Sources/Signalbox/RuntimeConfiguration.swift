import Foundation

/// Per-launch overrides. These never write to the user's saved settings.
struct RuntimeConfiguration: Sendable {
    /// Whether UI presentation may take focus and float above other windows.
    let foreground: Bool
    /// Open the jumplist at launch without requiring a global key event.
    let showJumplist: Bool

    /// Validated once before AppKit creates windows or starts the hub.
    static let current: RuntimeConfiguration = {
        do { return try RuntimeConfiguration(arguments: ProcessInfo.processInfo.arguments) }
        catch {
            FileHandle.standardError.write(Data("Signalbox: \(error)\n".utf8))
            exit(64)
        }
    }()

    init(arguments: [String]) throws {
        var foreground = true
        var showJumplist = false
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            var parameter: String?
            if argument == "--show-jumplist" { showJumplist = true }
            if argument == "--config-parameter" {
                index += 1
                guard index < arguments.count else { throw ConfigurationError.missingValue }
                parameter = arguments[index]
            } else if argument.hasPrefix("--config-parameter=") {
                parameter = String(argument.dropFirst("--config-parameter=".count))
            }
            if let parameter {
                let parts = parameter.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard parts.count == 2, parts[0] == "ui.foreground",
                      parts[1] == "true" || parts[1] == "false" else {
                    throw ConfigurationError.invalidValue
                }
                foreground = parts[1] == "true"
            }
            index += 1
        }
        self.foreground = foreground
        self.showJumplist = showJumplist
    }

    private enum ConfigurationError: Error, CustomStringConvertible {
        case missingValue, invalidValue
        var description: String {
            "--config-parameter expects ui.foreground=true or ui.foreground=false"
        }
    }
}
