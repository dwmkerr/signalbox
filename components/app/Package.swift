// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "Signalbox",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "1.9.4")
    ],
    targets: [
        .executableTarget(
            name: "Signalbox",
            dependencies: [
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts")
            ]
        )
    ]
)
