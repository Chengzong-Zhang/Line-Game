// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LifelineNativeStoreTests",
    platforms: [.macOS(.v12), .iOS(.v15)],
    targets: [
        .target(name: "LifelineStore", path: "App/App/Plugins", exclude: ["LifelineStoragePlugin.swift", "LifelinePlatformPlugins.swift", "LifelineReplayPlugins.swift"], sources: ["LifelineStore.swift"]),
        .testTarget(name: "LifelineStoreTests", dependencies: ["LifelineStore"], path: "App/AppTests")
    ]
)
