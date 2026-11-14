// swift-tools-version: 5.9

import PackageDescription

// AfmCore is the Swift side of the adapter (AfmBridge), with no Capacitor in it, so
// other hosts (an Electron addon, Tauri) build it too. AfmPlugin wraps it for
// Capacitor; `cap sync` adds this package to the iOS app.
let package = Package(
    name: "TanstackAiBrowserAfm",
    platforms: [.iOS(.v15), .macOS(.v14)],
    products: [
        .library(name: "TanstackAiBrowserAfm", targets: ["AfmPlugin"]),
        .library(name: "AfmCore", targets: ["AfmCore"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "AfmCore",
            path: "ios/Sources/AfmCore"
        ),
        .target(
            name: "AfmPlugin",
            dependencies: [
                "AfmCore",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AfmPlugin"
        )
    ]
)
