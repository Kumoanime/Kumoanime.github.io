import SwiftUI
import CoreText

enum Theme {
    static let bg = Color.black
    static let surface = Color(red: 18 / 255, green: 18 / 255, blue: 18 / 255)
    static let raise = Color(red: 30 / 255, green: 30 / 255, blue: 30 / 255)
    static let ink = Color(red: 244 / 255, green: 244 / 255, blue: 244 / 255)
    static let muted = Color(red: 160 / 255, green: 160 / 255, blue: 160 / 255)
    static let line = Color(red: 38 / 255, green: 38 / 255, blue: 38 / 255)
    static let accent = Color(red: 1, green: 92 / 255, blue: 147 / 255)
    static let accentInk = Color(red: 26 / 255, green: 10 / 255, blue: 18 / 255)
    static let logo = Color(red: 1, green: 138 / 255, blue: 31 / 255)
    static let ok = Color(red: 95 / 255, green: 211 / 255, blue: 160 / 255)
    static let star = Color(red: 1, green: 192 / 255, blue: 77 / 255)
    static let warn = Color(red: 245 / 255, green: 184 / 255, blue: 92 / 255)

    static func display(_ size: CGFloat) -> Font {
        .custom("DelaGothicOne-Regular", size: size)
    }

    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        switch weight {
        case .bold, .heavy, .black:
            return .custom("ZenKakuGothicNew-Bold", size: size)
        case .semibold, .medium:
            return .custom("ZenKakuGothicNew-Medium", size: size)
        default:
            return .custom("ZenKakuGothicNew-Regular", size: size)
        }
    }

    static func mono(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .monospaced)
    }

    static func registerFonts() {
        let names = [
            "DelaGothicOne-Regular",
            "ZenKakuGothicNew-Regular",
            "ZenKakuGothicNew-Medium",
            "ZenKakuGothicNew-Bold",
        ]
        for name in names {
            let url = Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
                ?? Bundle.main.url(forResource: name, withExtension: "ttf")
            guard let url else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

struct KumoMark: View {
    var size: CGFloat = 34

    var body: some View {
        Image("LogoMark")
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                    .stroke(Theme.line, lineWidth: 1)
            )
            .accessibilityHidden(true)
    }
}

struct KumoWordmark: View {
    var mark: CGFloat = 34
    var word: CGFloat = 22

    var body: some View {
        HStack(spacing: 9) {
            KumoMark(size: mark)
            Text("KUMO")
                .font(Theme.display(word))
                .foregroundStyle(Theme.logo)
                .tracking(word * 0.04)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Kumo")
    }
}
