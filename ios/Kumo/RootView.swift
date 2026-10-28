import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var tab: Tab = .home
    @State private var homePath = NavigationPath()
    @State private var searchPath = NavigationPath()
    @State private var watchPath = NavigationPath()
    @State private var splash = true

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            Group {
                switch tab {
                case .home:
                    stack($homePath) { HomeView() }
                case .search:
                    stack($searchPath) { SearchView() }
                case .watching:
                    stack($watchPath) { WatchingView() }
                case .addons:
                    NavigationStack { AddonsView() }
                }
            }
            if let toast = model.toast {
                VStack {
                    Spacer()
                    Text(toast)
                        .font(Theme.body(14, weight: .medium))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .background(Theme.ink, in: Capsule())
                        .padding(.bottom, 12)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Dock(tab: $tab)
        }
        .overlay { if splash { splashView } }
        .onChange(of: model.requestedTab, perform: { tab in
            if let tab { self.tab = tab; model.requestedTab = nil }
        })
        .onChange(of: model.pendingRoute, perform: { route in
            guard let route else { return }
            switch tab {
            case .home: homePath.append(route)
            case .search: searchPath.append(route)
            case .watching: watchPath.append(route)
            case .addons:
                tab = .home
                homePath.append(route)
            }
            model.pendingRoute = nil
        })
        .task {
            await model.loadNotes()
            let delay: UInt64 = UIAccessibility.isReduceMotionEnabled ? 350_000_000 : 1_400_000_000
            try? await Task.sleep(nanoseconds: delay)
            withAnimation(.easeOut(duration: 0.35)) { splash = false }
        }
    }

    private func stack<Content: View>(_ path: Binding<NavigationPath>, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack(path: path) {
            content()
                .navigationDestination(for: AppRoute.self) { route in
                    RouteScreen(route: route)
                }
        }
    }

    private var splashView: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            KumoWordmark(mark: 72, word: 42)
        }
        .accessibilityHidden(true)
    }
}
