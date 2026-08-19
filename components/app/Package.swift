// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "Signalbox",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "1.9.4"),
        .package(path: "../shared/AgentMarkdown")
    ],
    targets: [
        .executableTarget(
            name: "Signalbox",
            dependencies: [
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts"),
                .product(name: "AgentMarkdown", package: "AgentMarkdown")
            ]
        )
    ]
)
