// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "AgentMarkdown",
    // macOS 13 matches the menu bar app; iOS 18 matches the phone app's
    // deployment target.
    platforms: [.macOS(.v13), .iOS(.v18)],
    products: [
        .library(name: "AgentMarkdown", targets: ["AgentMarkdown"])
    ],
    targets: [
        .target(name: "AgentMarkdown"),
        .testTarget(name: "AgentMarkdownTests", dependencies: ["AgentMarkdown"])
    ]
)
