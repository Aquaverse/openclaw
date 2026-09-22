import AppKit
import Observation
import SwiftUI

/// Eligibility is decided by actually checking the managed CLI's on-disk
/// status (CLIInstaller.managedStatus()), not by a cached "onboarding
/// already happened" flag -- AppState.onboardingSeen/connectionMode live in
/// UserDefaults keyed by bundle id, which survives deleting OpenClaw.app
/// and reinstalling a fresh copy in its place (macOS does not clear a
/// bundle id's preferences just because the .app was trashed). Trusting
/// those flags alone would mean a real reinstall (or a `defaults delete`
/// meant to simulate one) permanently skips silent provisioning and lands
/// straight on the old "can't reach Gateway" screen forever after. So this
/// re-checks reality on every eligible launch: if the managed CLI is
/// already installed and healthy, it just brings app state back in line
/// and moves on (see the early-return branch in runIfEligible()); only when
/// it genuinely isn't there does it walk through CLI install, local
/// Gateway startup, and (if installer.env baked a default AI provider into
/// this build) a non-interactive model/provider setup -- exactly the steps
/// scripts/mac-pkg-postinstall.sh performs for a pkg install, but from
/// inside the app itself, so a plain dmg install gets the same "land
/// straight in chat, no manual clicks" experience. The CLI install always
/// goes through the same fast, production-style channel the pkg postinstall
/// script uses (an exact npm install matching this app's version, falling
/// back to the stable channel) -- never the git/dev source-build channel,
/// regardless of whether this particular app binary was compiled in Debug
/// or Release configuration; see the isDebug: false comment below for why.
/// Shows a small progress panel while it works, reusing CLIInstaller's
/// existing statusHandler callbacks for the step text.
///
/// Every step here is best-effort and never shows an alert or asks for
/// confirmation: any failure closes the panel, reverts connectionMode back
/// to .unconfigured, and returns false, and MenuBar falls back to showing
/// the normal, existing onboarding wizard exactly as if this had never run.
/// The CLI-install/Gateway-activation steps are safe and idempotent to
/// re-run even when some of this machine's state already looks partially
/// configured, so this can only make onboarding land in chat sooner -- it
/// can never leave the app worse off than before this existed.
@MainActor
final class AutoOnboardBootstrap {
    static let shared = AutoOnboardBootstrap()

    /// In-memory only, reset on every process launch -- deliberately NOT
    /// persisted to UserDefaults. Its only job is stopping two
    /// near-simultaneous callers within the same running app from both
    /// kicking off a real install; a persisted "ever attempted" flag would
    /// instead survive deleting OpenClaw.app and reinstalling a fresh copy
    /// (see the type-level doc comment above), permanently blocking silent
    /// provisioning on a machine that's actually back to a blank slate.
    /// Real eligibility is decided fresh every launch by actually checking
    /// the managed CLI's status below, not by a cached "did this run
    /// before" bit.
    private var hasRunThisLaunch = false

    /// True for as long as this launch's runIfEligible() call is active --
    /// from the moment it decides to act (right after the single-flight
    /// guard above) until it returns, whether via the fast "already ready"
    /// path or the full install pipeline. Exposed so other launch-time UI
    /// (currently DashboardManager's 2-second preload in MenuBar.swift) can
    /// hold off opening a window that would try to connect to a Gateway
    /// this might still be in the middle of installing/starting --
    /// connectionMode gets set to .local (or may already read .local from a
    /// stale prior run) well before the Gateway is actually up, so a naive
    /// "is this configured" check elsewhere can't tell the difference on
    /// its own. This is exactly what produced a "Dashboard unavailable,
    /// could not connect" window flashing up before this bootstrap's own
    /// progress panel and successful completion.
    private(set) var isProvisioning = false

    private var panel: NSPanel?
    private let status = AutoOnboardStatus()

    private init() {}

    func runIfEligible() async -> Bool {
        guard !self.hasRunThisLaunch else { return false }
        self.hasRunThisLaunch = true
        self.isProvisioning = true
        defer { self.isProvisioning = false }

        if case .ready = await CLIInstaller.managedStatus() {
            // The managed CLI is already installed and healthy on disk --
            // most likely a prior successful provisioning whose
            // onboardingSeen flag didn't carry over (e.g. a fresh reinstall
            // over the same still-intact ~/.openclaw). Nothing to install;
            // just bring app state back in line with reality and land in
            // chat like any other already-configured launch, rather than
            // running the whole install pipeline again or falling through
            // to the manual wizard.
            AppStateStore.shared.connectionMode = .local
            AppStateStore.shared.onboardingSeen = true
            if await CLIInstaller.activateLocalGateway() == .ready {
                AppNavigationActions.openChat()
            }
            return true
        }

        self.status.step = String(localized: "Getting things ready…")
        self.showPanel()
        defer { self.closePanel() }

        // CLIInstaller.activateLocalGateway() below reads
        // AppStateStore.shared.connectionMode by default, and other app code
        // (e.g. CLIInstallPrompter's own gating) treats .local as "this is a
        // local install in progress" -- set it up front so all of that lines
        // up with what's actually happening. Reverted to .unconfigured on
        // every failure path below so a fallback to the manual wizard starts
        // from the same clean state it would have without this ever running
        // (leaving connectionMode == .local with nothing actually installed
        // is exactly the "Dashboard unavailable, can't reach 127.0.0.1"
        // half-configured state this is trying to avoid).
        AppStateStore.shared.connectionMode = .local

        // isDebug is forced to false here -- deliberately NOT
        // CLIInstallBuild.isDebug -- so this always resolves to the same
        // fast, production-style channel scripts/mac-pkg-postinstall.sh
        // uses (installScriptCommand only adds --install-method git when
        // the target is exactly .channel(.dev)): an exact npm install
        // matching this app's version, or the stable/beta channel as a
        // fallback. CLIInstaller's isDebug-aware channel selection exists
        // for the interactive channel picker developers use on purpose
        // (CLIInstallPrompter), not for a launch meant to look like an
        // ordinary first run -- using the git/dev channel here means
        // cloning the whole repo and building the CLI from source on first
        // launch, which is what made this take minutes instead of seconds
        // whenever this app binary happened to be a Debug build.
        let appVersion = GatewayEnvironment.appVersionString()
        let target = CLIInstaller.automaticInstallTarget(appVersion: appVersion, isDebug: false)
            ?? .channel(CLIInstaller.suggestedChannel(appVersion: appVersion, isDebug: false))

        let installed = await CLIInstaller.install(target: target) { [weak self] message in
            self?.status.step = message
        }
        guard installed else {
            AppStateStore.shared.connectionMode = .unconfigured
            return false
        }

        self.status.step = String(localized: "Starting OpenClaw Gateway…")
        let activation = await CLIInstaller.activateLocalGateway()
        guard activation == .ready else {
            AppStateStore.shared.connectionMode = .unconfigured
            return false
        }

        if let provider = Self.bundledDefaultProvider() {
            self.status.step = String(localized: "Configuring default model…")
            // Best-effort only: the Gateway is already up either way, so a
            // failure here just leaves the model picker for the user on
            // first chat instead of failing the whole bootstrap.
            _ = await Self.applyDefaultProvider(provider)
        }

        AppStateStore.shared.onboardingSeen = true
        AppNavigationActions.openChat()
        return true
    }

    // MARK: - Progress panel

    private func showPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 120),
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        panel.title = "OpenClaw"
        panel.isReleasedWhenClosed = false
        panel.isRestorable = false
        panel.level = .floating
        panel.collectionBehavior = [.moveToActiveSpace]
        // Must stay visible while this menu-bar app is inactive, same as
        // DashboardAlertPresenter's panel.
        panel.hidesOnDeactivate = false
        let hostingView = NSHostingView(rootView: AutoOnboardStatusView(status: self.status))
        panel.contentView = hostingView
        panel.setContentSize(hostingView.fittingSize)
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        self.panel = panel
    }

    private func closePanel() {
        self.panel?.close()
        self.panel = nil
    }

    // MARK: - Default AI provider (installer.env, baked in by
    // scripts/build-mac-installer.sh as Contents/Resources/default-ai-provider.env)

    private struct DefaultProvider {
        let id: String?
        let baseURL: String
        let modelID: String
        let apiKey: String?
    }

    private static func bundledDefaultProvider() -> DefaultProvider? {
        let envURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/default-ai-provider.env")
        guard let contents = try? String(contentsOf: envURL, encoding: .utf8) else { return nil }
        var values: [String: String] = [:]
        for line in contents.split(whereSeparator: \.isNewline) {
            guard let separatorIndex = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<separatorIndex])
            let value = String(line[line.index(after: separatorIndex)...])
            values[key] = value
        }
        let baseURL = values["DEFAULT_AI_BASE_URL"] ?? ""
        let modelID = values["DEFAULT_AI_MODEL"] ?? ""
        guard !baseURL.isEmpty, !modelID.isEmpty else { return nil }
        let providerID = values["DEFAULT_AI_PROVIDER"]
        let apiKey = values["DEFAULT_AI_API_KEY"]
        return DefaultProvider(
            id: (providerID?.isEmpty ?? true) ? nil : providerID,
            baseURL: baseURL,
            modelID: modelID,
            apiKey: (apiKey?.isEmpty ?? true) ? nil : apiKey)
    }

    /// Shells out to the just-installed CLI's own `openclaw onboard
    /// --non-interactive`, the same command scripts/mac-pkg-postinstall.sh
    /// runs for a pkg install -- reuses its exact validated flag set rather
    /// than duplicating provider/config-writing logic here. --skip-daemon
    /// because activateLocalGateway() above already started the Gateway;
    /// this call only needs to fill in the model/provider config.
    private static func applyDefaultProvider(_ provider: DefaultProvider) async -> Bool {
        let executable = CLIInstaller.managedExecutableLocation()
        guard FileManager.default.isExecutableFile(atPath: executable) else { return false }
        var arguments = [
            "onboard", "--non-interactive", "--accept-risk",
            "--mode", "local", "--skip-daemon",
            "--skip-health", "--skip-ui", "--skip-hooks", "--skip-channels",
            "--skip-search", "--skip-skills", "--skip-bootstrap",
            "--auth-choice", "custom-api-key",
            "--custom-base-url", provider.baseURL,
            "--custom-model-id", provider.modelID,
            "--custom-compatibility", "openai",
        ]
        if let id = provider.id {
            arguments.append(contentsOf: ["--custom-provider-id", id])
        }
        if let apiKey = provider.apiKey {
            arguments.append(contentsOf: ["--custom-api-key", apiKey])
        }
        let command = AppProfile.current.localCLICommand(prefix: [executable], arguments: arguments)
        let response = await ShellExecutor.run(command: command, cwd: nil, env: nil, timeout: 60)
        return response.ok
    }
}

@MainActor
@Observable
private final class AutoOnboardStatus {
    var step: String = ""
}

@MainActor
private struct AutoOnboardStatusView: View {
    let status: AutoOnboardStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                ProgressView()
                    .controlSize(.small)
                Text("Setting up OpenClaw…")
                    .font(.headline)
            }
            Text(self.status.step)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 360, alignment: .leading)
    }
}
