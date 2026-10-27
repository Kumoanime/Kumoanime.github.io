# Kumo for iPhone

Kumo is an anime-only app in the style of Stremio. This folder is the native iPhone version. The website in the rest of the repository is unchanged.

The iPhone browser cannot play the MKV files Real-Debrid sends (HEVC video and AC3 audio), and public Comet links from ElfHosted only work for the address that asked for the stream list. This app asks for streams from the phone and plays the original file with VLC, so those links open on the device.

You do not need to be a developer. You do need a computer **once** to put the app on the phone. An unsigned install file cannot be installed by an iPhone on its own. Apple requires every app to be signed with an Apple ID.

## What you get

- Black screens with an orange K, and the same Home, Search, Watching, and Add-ons tabs as the website
- Show info from AniList, plus catalogues from any Stremio add-on you install
- Episode lists, SUB and DUB groups, and cached ⚡ sources listed first
- Auto Play, Auto Next, and Skip intro
- A player with play, pause, seek, audio tracks, and subtitle tracks (including subtitles inside an MKV)
- Add-ons and settings saved on the phone. A Real-Debrid token you paste is saved in the iPhone Keychain

There is no account login. Your watch list stays on this phone.

## Path A — you only have an iPhone

Borrow a Windows PC or a Mac for a few minutes. You cannot finish this with the phone alone.

1. On the phone, open this repository on GitHub: [Kumoanime/Kumoanime.github.io](https://github.com/Kumoanime/Kumoanime.github.io).
2. Tap **Actions**.
3. Open the **iOS** workflow, then the latest run with a green check.
4. Download the artifact named **Kumo-unsigned-ipa**. GitHub gives you a zip. Unzip it. Inside is `Kumo-unsigned.ipa`.
5. Move that `.ipa` to the computer you borrowed (AirDrop, a cable, email to yourself, or a USB drive).

Then use Path B (Windows) or Path C (Mac).

If Actions has no green run yet, open the **iOS** workflow and click **Run workflow**. Wait until it finishes, then download the artifact. Builds are kept for 14 days. If the artifact is gone, run the workflow again.

## Path B — Windows, with a free Apple ID (Sideloadly)

This is the usual path when you do not own a Mac. The free Apple ID signature lasts **7 days**. After that the app will not open until you sign it again the same way. You can install about 3 apps this way.

1. On the iPhone, install the free **Apple Devices** app is not required. You do need a cable, or Wi-Fi sync already set up.
2. On Windows, download [Sideloadly](https://sideloadly.io) and install it. Also install iTunes or Apple Devices from the Microsoft Store if Sideloadly asks for it.
3. Plug in the iPhone and tap **Trust** on the phone.
4. Open Sideloadly. Sign in with your Apple ID (a free one is enough). Sideloadly only uses it to sign the app.
5. Drag `Kumo-unsigned.ipa` into Sideloadly. Leave the defaults and click **Start**.
6. On the iPhone open **Settings → General → VPN & Device Management**, tap your Apple ID, and tap **Trust**.
7. Open Kumo.

To keep it working, plug the phone into that PC before the 7 days are up and click Start again. Sideloadly can also refresh the app automatically while the PC is on.

[AltStore](https://altstore.io) is the same idea: install AltServer on the computer, then AltStore on the phone, and add the `.ipa` from AltStore. The free signature still lasts 7 days. [SideStore](https://sidestore.io) can refresh later on the phone itself, but the first install still needs a computer.

## Path C — Mac and Xcode, free Apple ID

The free signature lasts **7 days**. Plug the phone back in and press Run again to renew it.

1. Install **Xcode** from the Mac App Store. Open it once and let it install the extra components. This needs several gigabytes of disk space.
2. Download the repository (the green **Code** button, then **Download ZIP**) and unzip it.
3. Open `ios/Kumo.xcodeproj`. The first open downloads the video player (MobileVLCKit). Wait until that finishes. It is a large download.
4. In the Xcode toolbar, set the run destination to your iPhone (not a simulator). Plug the phone in and tap Trust.
5. Click the blue **Kumo** project in the left sidebar, select the **Kumo** target, open **Signing & Capabilities**, turn on **Automatically manage signing**, and choose your Apple ID as the Team. If you have not added it: Xcode menu **Settings → Accounts → +**.
6. If Xcode says the bundle id is already used, change **Bundle Identifier** from `io.kumoanime.kumo` to something only you use, such as `io.kumoanime.kumo.yourname`.
7. Press the Run button (the triangle).
8. On the iPhone: **Settings → General → VPN & Device Management → Trust**.

If Xcode says the project is damaged, or the player package is missing, install [XcodeGen](https://github.com/yonaskolb/XcodeGen) and regenerate:

```bash
brew install xcodegen
cd ios
xcodegen generate
```

Then open `ios/Kumo.xcodeproj` again. `ios/project.yml` is the file that describes the project.

## Path D — TestFlight ($99 a year)

This is the one that keeps working on the phone without a computer nearby. You still need a Mac once, to upload the build.

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) ($99 per year).
2. Follow Path C, but choose that paid team in Signing & Capabilities.
3. In Xcode choose **Product → Archive**. When it finishes, **Distribute App → App Store Connect → Upload**.
4. On [App Store Connect](https://appstoreconnect.apple.com) open the app, then **TestFlight**, and add your Apple ID as a tester. The first build waits on a short Apple processing step.
5. On the iPhone, install Apple's **TestFlight** app and install Kumo from there.

TestFlight builds last 90 days. Upload a new archive before then. A paid account can also refresh a normal install for a year instead of 7 days.

## After it is on the phone

1. Open **Add-ons**.
2. Paste the add-on link you already use on the website (Comet, Torrentio, or another Stremio manifest). `stremio://` links are fine. If that link contains your Real-Debrid key, leave it in the link. Kumo keeps the link as you pasted it.
3. Or paste a Real-Debrid API token in the Real-Debrid box. It is saved in the Keychain on this phone.
4. Open a show, pick an episode, and press play. Cached sources (marked ⚡) are tried first.

If a Comet link lands on an ElfHosted error slate, or Real-Debrid returns an error, Kumo tries the next cached source **once** and then stops. A source you tap stays selected. It does not jump away to another source.

Kumo does not send the video through a proxy, and it does not ask Real-Debrid to transcode to HLS. The player decodes the original file.

## Rebuild the install file yourself

On a Mac, from the repository:

```bash
brew install xcodegen
cd ios
xcodegen generate
xcodebuild \
  -project Kumo.xcodeproj \
  -scheme Kumo \
  -configuration Release \
  -destination "generic/platform=iOS" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGN_IDENTITY="" \
  DEVELOPMENT_TEAM="" \
  -derivedDataPath build \
  build
mkdir -p Payload
cp -R build/Build/Products/Release-iphoneos/Kumo.app Payload/
zip -ry Kumo-unsigned.ipa Payload
```

That `.ipa` is unsigned. Install it with Sideloadly, AltStore, or by running from Xcode with your Apple ID. GitHub Actions runs the same build on a Mac and uploads the artifact so you do not need your own Mac to compile.

## Fonts

The wordmark uses [Dela Gothic One](https://fonts.google.com/specimen/Dela+Gothic+One) and [Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New), both under the SIL Open Font License. The license text is in `Kumo/Fonts/`.
