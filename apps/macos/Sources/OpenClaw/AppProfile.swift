import Darwin
import Foundation
import OpenClawIPC

struct AppProfile: Equatable, Sendable {
    struct ValidationError: LocalizedError, Equatable, Sendable {
        let rawValue: String
        let reason: String

        var errorDescription: String? {
            "Invalid OPENCLAW_PROFILE \"\(self.rawValue)\": \(self.reason)"
        }
    }

    static let current = Self(
        environment: ProcessInfo.processInfo.environment,
        bundledDefaultProfile: Bundle.main.object(forInfoDictionaryKey: "OpenClawDefaultProfile") as? String,
        distribution: .current)

    let name: String?
    let validationError: ValidationError?
    let distribution: AppDistribution

    init(
        environment: [String: String],
        bundledDefaultProfile: String? = nil,
        distribution: AppDistribution = .current)
    {
        self.distribution = distribution
        let selected = environment.keys.contains("OPENCLAW_PROFILE")
            ? environment["OPENCLAW_PROFILE"]
            : bundledDefaultProfile
        let raw = selected?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty || raw.lowercased() == "default" {
            self.name = nil
            self.validationError = nil
            return
        }
        if let reason = MacControlProfile.validationReason(raw) {
            self.name = nil
            self.validationError = ValidationError(rawValue: raw, reason: reason)
            return
        }
        self.name = raw
        self.validationError = nil
    }

    var isActive: Bool {
        self.name != nil
    }

    var gatewayLaunchAgentLabel: String {
        if self.distribution.identityPrefix == "ai.pepio", self.name == "nexus" {
            return self.distribution.identityPrefix
        }
        // Keep this byte-for-byte aligned with src/daemon/constants.ts
        // resolveGatewayLaunchAgentLabel; the CLI owns the managed service.
        self.name.map { "\(self.distribution.identityPrefix).\($0)" }
            ?? "\(self.distribution.identityPrefix).gateway"
    }

    var defaultsSuiteName: String? {
        // Named profiles need a stable domain even when dev and packaged bundle ids differ.
        self.name.map { "\(self.distribution.identityPrefix).mac.profile.\($0)" }
    }

    var keychainServiceSuffix: String {
        self.name.map { ".profile.\($0)" } ?? ""
    }

    func keychainService(base: String) -> String {
        self.distribution.serviceName(base: base) + self.keychainServiceSuffix
    }

    func stateDirectoryURL(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        self.distribution.stateDirectoryURL(profileName: self.name, homeDirectory: homeDirectory)
    }

    func resolvedStateDirectoryURL(
        environmentOverride: String?,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL
    {
        // A branded distribution owns one explicit state root. Do not let an inherited
        // OpenClaw override recreate the legacy profile directory after migration.
        if self.distribution.stateDirectoryName != nil {
            return self.stateDirectoryURL(homeDirectory: homeDirectory)
        }
        guard let environmentOverride, !environmentOverride.isEmpty else {
            return self.stateDirectoryURL(homeDirectory: homeDirectory)
        }
        return URL(
            fileURLWithPath: (environmentOverride as NSString).expandingTildeInPath,
            isDirectory: true).standardizedFileURL
    }

    var cliRootArguments: [String] {
        self.name.map { ["--profile", $0] } ?? []
    }

    func localCLICommand(prefix: [String], arguments: [String]) -> [String] {
        prefix + self.cliRootArguments + arguments
    }

    var instanceLockName: String {
        self.name.map { "\(self.distribution.identityPrefix).mac.profile.\($0)" }
            ?? "\(self.distribution.identityPrefix).mac"
    }

    func instanceLockURL(systemTemporaryDirectory: URL = URL(fileURLWithPath: "/tmp", isDirectory: true)) -> URL {
        // Service/defaults/Keychain identity follows only the profile; state overrides must not split this lock.
        systemTemporaryDirectory
            .appendingPathComponent(
                "\(self.distribution.fileName.lowercased())-\(geteuid())-app-instances",
                isDirectory: true)
            .appendingPathComponent("\(self.instanceLockName).lock", isDirectory: false)
    }

    var defaultGatewayPort: Int {
        guard let name else { return 18789 }
        if name == "dev" { return 19001 }
        // Keep byte-for-byte aligned with src/cli/profile-utils.ts resolveProfileGatewayPort so the app and CLI
        // connect to the same profile Gateway.
        var hash: UInt32 = 2_166_136_261
        for byte in name.utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        return 20000 + Int(hash % 40000)
    }
}

enum AppDefaults {
    /// UserDefaults synchronizes access internally; the selected suite is immutable for this process.
    nonisolated(unsafe) static let standard: UserDefaults = {
        guard let suiteName = AppProfile.current.defaultsSuiteName else {
            return UserDefaults.standard
        }
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            fatalError("Could not create UserDefaults suite \(suiteName)")
        }
        return defaults
    }()
}
