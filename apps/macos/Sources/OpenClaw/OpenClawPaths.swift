import Foundation

enum OpenClawEnv {
    static func path(_ key: String) -> String? {
        // Normalize env overrides once so UI + file IO stay consistent.
        guard let raw = getenv(key) else { return nil }
        return String(cString: raw).nonEmpty
    }
}

enum OpenClawPaths {
    static var stateDirURL: URL {
        AppProfile.current.resolvedStateDirectoryURL(
            environmentOverride: OpenClawEnv.path("OPENCLAW_STATE_DIR"))
    }

    static var configURL: URL {
        if let override = OpenClawEnv.path("OPENCLAW_CONFIG_PATH") {
            return URL(fileURLWithPath: override)
        }
        return self.stateDirURL.appendingPathComponent("openclaw.json")
    }
}
