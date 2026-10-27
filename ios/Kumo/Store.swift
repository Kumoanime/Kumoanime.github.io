import Foundation

/// Add-ons, watch list, progress, and player settings. The Real-Debrid token is not stored here.
enum Store {
    private static let defaults = UserDefaults.standard

    static func get<T: Decodable>(_ key: String, as type: T.Type, default def: T) -> T {
        guard let data = defaults.data(forKey: "kumo." + key) else { return def }
        return (try? JSONDecoder().decode(T.self, from: data)) ?? def
    }

    static func set<T: Encodable>(_ key: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: "kumo." + key)
    }

    static func double(_ key: String) -> Double {
        defaults.double(forKey: "kumo." + key)
    }

    static func setDouble(_ key: String, _ value: Double) {
        defaults.set(value, forKey: "kumo." + key)
    }
}
