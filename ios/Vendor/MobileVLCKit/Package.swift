// swift-tools-version:5.9
import PackageDescription

// Prebuilt MobileVLCKit (libvlc) so the app can decode MKV, HEVC, and AC3
// on device. The zip is the Swift Package Manager release of 3.7.3.
let package = Package(
    name: "MobileVLCKit",
    platforms: [.iOS(.v12)],
    products: [
        .library(name: "MobileVLCKit", targets: ["MobileVLCKit"])
    ],
    targets: [
        .binaryTarget(
            name: "MobileVLCKit",
            url: "https://github.com/showbie/MobileVLCKit-SPM/releases/download/3.7.3/MobileVLCKit.xcframework.zip",
            checksum: "0346e458e119d57d4768d4096e2f7b4f77b7a0df4e21d0e728856f309cc6e8ab"
        )
    ]
)
