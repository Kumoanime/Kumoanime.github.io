import SwiftUI

struct CalendarView: View {
    @EnvironmentObject private var model: AppModel
    @State private var all = false
    @State private var slots: [AiringSlot] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("This week").font(Theme.display(26))
                    Spacer()
                    Button(all ? "Only Watching" : "All airing anime") {
                        all.toggle()
                        Task { await load() }
                    }
                    .font(Theme.body(13, weight: .bold))
                    .foregroundStyle(Theme.logo)
                }
                if loading {
                    ProgressView().tint(Theme.logo)
                } else if failed {
                    EmptyBlock(title: "Couldn't load the calendar", message: "AniList didn't respond. Try again in a bit.")
                } else if !all && model.watchingItems().isEmpty {
                    EmptyBlock(title: "Nothing on your Watching list", message: "Add a show with + Watching, or switch to all airing anime.")
                } else {
                    ForEach(days, id: \.key) { day in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(day.label).font(Theme.display(16))
                            let rows = slots.filter { dayKey($0.airingAt) == day.key }
                            if rows.isEmpty {
                                Text("Nothing airing")
                                    .font(Theme.body(13))
                                    .foregroundStyle(Theme.muted)
                            } else {
                                ForEach(rows) { row in
                                    NavigationLink(value: AppRoute.anime(row.mediaID)) {
                                        HStack(spacing: 12) {
                                            PosterImage(url: row.poster)
                                                .frame(width: 42, height: 62)
                                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(row.title).font(Theme.body(15, weight: .bold)).foregroundStyle(Theme.ink)
                                                Text("Episode \(row.episode) · \(timeLabel(row.airingAt))")
                                                    .font(Theme.body(13))
                                                    .foregroundStyle(Theme.muted)
                                            }
                                            Spacer(minLength: 0)
                                        }
                                        .padding(8)
                                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationTitle("This week")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var days: [(key: String, label: String)] {
        let start = model.weekBounds().start
        let calendar = Calendar.current
        return (0..<7).compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: offset, to: start) else { return nil }
            let key = dayKey(Int(date.timeIntervalSince1970))
            let label = date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
            return (key, label)
        }
    }

    private func load() async {
        loading = true
        failed = false
        if !all && model.watchingItems().isEmpty {
            slots = []
            loading = false
            return
        }
        do {
            slots = try await model.airingWeek(all: all)
            loading = false
        } catch {
            failed = true
            loading = false
        }
    }

    private func dayKey(_ unix: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(unix))
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private func timeLabel(_ unix: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(unix)).formatted(date: .omitted, time: .shortened)
    }
}
