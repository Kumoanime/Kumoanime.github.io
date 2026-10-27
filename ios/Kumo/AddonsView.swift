import SwiftUI

struct AddonsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var addonURL = ""
    @State private var repoURL = ""
    @State private var token = ""
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Add-ons").font(Theme.display(26))
                install
                repository
                realDebrid
                installed
                repos
            }
            .padding(16)
            .padding(.bottom, 12)
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { KumoWordmark(mark: 28, word: 18) }
        }
    }

    private var install: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHead(title: "Install an add-on")
            Text("Paste the link to a Stremio-compatible add-on. It usually ends in manifest.json. stremio:// links work too.")
                .font(Theme.body(14))
                .foregroundStyle(Theme.muted)
            field($addonURL, "https://example.com/manifest.json") {
                Task { await run { await model.installAddon(addonURL); addonURL = "" } }
            }
        }
    }

    private var repository: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHead(title: "Add a repository")
            Text("A repository is a link to a list of add-ons. Add one to browse what's in it.")
                .font(Theme.body(14))
                .foregroundStyle(Theme.muted)
            field($repoURL, "https://example.com/repo.json") {
                Task { await run { await model.addRepo(repoURL); repoURL = "" } }
            }
        }
    }

    private var realDebrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHead(title: "Real-Debrid")
            Text("Kumo plays the original file on this iPhone, including MKV, HEVC, and AC3. The link is opened from this device, so Comet and Real-Debrid see the same address that asked for the list. No proxy and no HLS transcode.")
                .font(Theme.body(14))
                .foregroundStyle(Theme.muted)
            Text(model.tokenDescription())
                .font(Theme.body(14))
                .foregroundStyle(Theme.ink)
            SecureField(model.hasPastedToken ? "Token saved — paste a new one to replace" : "Real-Debrid API token", text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(Theme.body(16))
                .padding(13)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
            HStack(spacing: 8) {
                Button("Save") {
                    model.savePastedToken(token)
                    token = ""
                }
                .buttonStyle(OrangeButtonStyle())
                .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if model.hasPastedToken {
                    Button("Forget pasted token") { model.clearPastedToken() }
                        .buttonStyle(GhostButtonStyle())
                }
            }
            Text("The token stays in this iPhone's Keychain. Add-on links that already contain a key are left as-is and stored with the add-on.")
                .font(Theme.body(13))
                .foregroundStyle(Theme.muted)
        }
    }

    private var installed: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: "Installed", note: "\(model.addons.filter(\.enabled).count) on")
            if model.addons.isEmpty {
                EmptyBlock(title: "No add-ons yet", message: "Install one above. Catalogues, episodes, and subtitles all come from add-ons.")
            } else {
                ForEach(model.addons) { addon in
                    addonRow(addon)
                }
            }
        }
    }

    private var repos: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(model.repos) { repo in
                VStack(alignment: .leading, spacing: 10) {
                    SectionHead(title: repo.name, note: "Repository")
                    ForEach(repo.entries) { entry in
                        repoRow(entry)
                    }
                    Button("Remove repository") { model.removeRepo(repo.url) }
                        .buttonStyle(GhostButtonStyle())
                }
            }
        }
    }

    private func addonRow(_ addon: InstalledAddon) -> some View {
        HStack(alignment: .top, spacing: 10) {
            logo(addon.manifest.logo, fallback: addon.manifest.name)
            VStack(alignment: .leading, spacing: 4) {
                Text(addon.manifest.name).font(Theme.body(15, weight: .bold))
                if !addon.manifest.description.isEmpty {
                    Text(addon.manifest.description)
                        .font(Theme.body(13))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(3)
                }
                HStack(spacing: 6) {
                    ForEach(addon.manifest.resources, id: \.name) { resource in
                        tag(resource.name)
                    }
                    tag("v\(addon.manifest.version)")
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                Toggle("On", isOn: Binding(
                    get: { addon.enabled },
                    set: { model.setAddon(addon.url, enabled: $0) }
                ))
                .labelsHidden()
                .tint(Theme.logo)
                Button("Remove") { model.removeAddon(addon.url) }
                    .buttonStyle(GhostButtonStyle())
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    private func repoRow(_ entry: RepoEntry) -> some View {
        let installed = model.addons.contains { AddonURLs.addonKey($0.url) == AddonURLs.addonKey(entry.url) }
        return HStack(alignment: .center, spacing: 10) {
            logo(nil, fallback: entry.name)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(Theme.body(15, weight: .bold)).lineLimit(1)
                Text(entry.description.isEmpty ? entry.url : entry.description)
                    .font(Theme.body(12))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if installed {
                tag("Installed")
            } else {
                Button("Install") {
                    Task { await run { await model.installAddon(entry.url) } }
                }
                .buttonStyle(OrangeButtonStyle())
                .disabled(busy)
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private func field(_ text: Binding<String>, _ placeholder: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .font(Theme.body(15))
                .submitLabel(.done)
                .onSubmit(action)
            Button("Add", action: action)
                .buttonStyle(OrangeButtonStyle())
                .disabled(busy || text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(8)
        .padding(.leading, 6)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    private func logo(_ url: String?, fallback: String) -> some View {
        PosterImage(url: url)
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                if url?.nilIfEmpty == nil {
                    Text(String(fallback.prefix(1)).uppercased())
                        .font(Theme.display(16))
                        .foregroundStyle(Theme.logo)
                }
            }
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(Theme.mono(10))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Theme.raise, in: Capsule())
    }

    private func run(_ work: @escaping () async -> Void) async {
        guard !busy else { return }
        busy = true
        await work()
        busy = false
    }
}

struct OrangeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.body(14, weight: .bold))
            .foregroundStyle(.black)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.logo.opacity(configuration.isPressed ? 0.7 : 1), in: Capsule())
    }
}

struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.body(13, weight: .bold))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.raise.opacity(configuration.isPressed ? 0.6 : 1), in: Capsule())
            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
    }
}
