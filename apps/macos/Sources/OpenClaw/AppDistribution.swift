import Foundation
import OpenClawIPC

/// Product-facing namespaces baked into branded app bundles. The default values
/// preserve upstream OpenClaw behavior; Ask Pepio supplies only Info.plist data.
struct AppDistribution: Equatable, Sendable {
    static let current = Self(infoDictionary: Bundle.main.infoDictionary ?? [:])

    let displayName: String
    let fileName: String
    let identityPrefix: String
    let stateDirectoryName: String?
    let applicationSupportName: String
    let logDirectoryName: String
    let cacheDirectoryName: String
    let domain: String?

    init(infoDictionary: [String: Any]) {
        func string(_ key: String) -> String? {
            (infoDictionary[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        }

        self.displayName = string("OpenClawProductDisplayName") ?? "OpenClaw"
        self.fileName = string("OpenClawProductFileName") ?? "OpenClaw"
        self.identityPrefix = string("OpenClawProductIdentityPrefix") ?? "ai.openclaw"
        self.stateDirectoryName = string("OpenClawProductStateDirectoryName")
        self.applicationSupportName = string("OpenClawProductApplicationSupportName") ?? "OpenClaw"
        self.logDirectoryName = string("OpenClawProductLogDirectoryName") ?? "OpenClaw"
        self.cacheDirectoryName = string("OpenClawProductCacheDirectoryName") ?? "openclaw"
        self.domain = string("OpenClawProductDomain")
    }

    func serviceName(base: String) -> String {
        guard self.identityPrefix != "ai.openclaw", base.hasPrefix("ai.openclaw") else { return base }
        return self.identityPrefix + String(base.dropFirst("ai.openclaw".count))
    }

    func branded(_ value: String) -> String {
        guard self.displayName != "OpenClaw" else { return value }
        return value.replacingOccurrences(of: "OpenClaw", with: self.displayName)
    }

    func stateDirectoryURL(
        profileName: String?,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL
    {
        guard let stateDirectoryName else {
            return MacControlProfile.stateDirectoryURL(name: profileName, homeDirectory: homeDirectory)
        }
        let name = if profileName == nil || profileName == "nexus" {
            stateDirectoryName
        } else {
            "\(stateDirectoryName)-\(profileName ?? "default")"
        }
        return homeDirectory.appendingPathComponent(name, isDirectory: true)
    }

    func applicationSupportDirectoryURL(
        fileManager: FileManager = .default) -> URL?
    {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(self.applicationSupportName, isDirectory: true)
    }

    func logDirectoryURL(fileManager: FileManager = .default) -> URL {
        let library = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library", isDirectory: true)
        return library
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent(self.logDirectoryName, isDirectory: true)
    }
}
