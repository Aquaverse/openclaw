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
    // Temporary instrumentation while diagnosing reports of the "Setting up
    // OpenClaw..." panel taking a long time (or a Dock/menu-bar click) to
    // actually appear on a cold double-click launch -- pins down whether the
    // delay is before runIfEligible() even starts running (queued behind
    // other synchronous applicationDidFinishLaunching work) or after
    // (inside the CLI-install pipeline itself). Safe to remove once that's
    // confirmed.
    private let logger = Logger(subsystem: "ai.openclaw", category: "AutoOnboard")

    private init() {}

    func runIfEligible() async -> Bool {
        guard !self.hasRunThisLaunch else { return false }
        self.hasRunThisLaunch = true
        self.isProvisioning = true
        defer { self.isProvisioning = false }
        self.logger.notice("runIfEligible: entered")
        traceLog("runIfEligible: entered")

        // A kept ~/.openclaw whose CLI came from an older bundle (or the npm
        // registry, at the same or an older version) is not "ready" for this
        // app: fall through to the full pipeline below, which reinstalls the
        // CLI from this app's bundled package over the existing state (config,
        // sessions and the downloaded llama.cpp model are left in place).
        if case let .ready(_, installedVersion) = await CLIInstaller.managedStatus(),
           !CLIInstaller.bundledCLIPackageNeedsInstall(installedVersion: installedVersion)
        {
            // The managed CLI is already installed and healthy on disk --
            // most likely a prior successful provisioning whose
            // onboardingSeen flag didn't carry over (e.g. a fresh reinstall
            // over the same still-intact ~/.openclaw), or an earlier launch
            // that installed the CLI but was quit/killed before reaching
            // this function's own full pipeline below (which is the only
            // place that otherwise applies the bundled default model).
            // Nothing to install; just bring app state back in line with
            // reality and land in chat like any other already-configured
            // launch, rather than running the whole install pipeline again
            // or falling through to the manual wizard.
            AppStateStore.shared.connectionMode = .local
            AppStateStore.shared.onboardingSeen = true
            // Best-effort, same as the full pipeline below: mirrors
            // scripts/mac-pkg-postinstall.sh always (re-)running
            // `openclaw onboard --non-interactive` regardless of whether
            // the CLI was already present, rather than skipping default
            // model configuration whenever this fast path is taken.
            // Without this, a launch that reaches this branch because an
            // earlier one was interrupted before configuring the default
            // model (installed the CLI, then got force-quit) would mark
            // onboarding fully complete here and never configure a
            // default model at all -- the app looks "installed" with no
            // model picked, only fixable by hand in Model Management.
            //
            // Deliberately reordered ahead of activateLocalGateway() below
            // (was: activate, then configure), same reasoning as the full
            // pipeline further down. This fast path routinely attaches to a
            // Gateway left running from a previous launch; openclaw onboard
            // --skip-daemon only writes config, it does not restart that
            // process, and a Gateway that's already up only reads config
            // once, at its own startup. In testing this meant the Gateway
            // separately noticed the config file change on its own and
            // self-restarted (its own SIGUSR2 reload-for-restart path,
            // relying on launchd's KeepAlive to bring it back) -- which
            // does eventually land the right model, but shows a several-
            // second "reconnecting" Dashboard blip in the meantime, and if
            // that self-restart doesn't fire (or the app is quit mid-cycle)
            // the default model silently never gets configured at all.
            // Writing config first avoids that whole cycle: whatever
            // process activateLocalGateway() attaches to or starts next
            // reads the already-correct config from its own first boot.
            if let provider = Self.bundledDefaultProvider() {
                traceLog("runIfEligible: fast path re-applying bundled default provider")
                let applied = await Self.applyDefaultProvider(provider)
                traceLog("runIfEligible: fast path applyDefaultProvider() returned \(applied)")
            } else {
                traceLog("runIfEligible: fast path found no bundled default provider -- skipping")
            }
            if await CLIInstaller.activateLocalGateway() == .ready {
                AppNavigationActions.openChat()
            }
            Self.launchLlamaFallbackSetupInBackground()
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

        // Always installs the same "latest" stable channel
        // scripts/mac-pkg-postinstall.sh's install-cli.sh invocation
        // defaults to (OPENCLAW_VERSION unset -> "latest") --
        // deliberately NOT CLIInstaller.automaticInstallTarget's
        // exact-version-pinned-to-this-app-build behavior. Pinning to an
        // exact version here used to mean a dmg install and a pkg install
        // of the same app build could resolve to two different openclaw
        // versions against the *same* ~/.openclaw state (pkg always
        // installs npm's current "latest", dmg pinned to this app
        // bundle's own version number). Whichever one wrote
        // ~/.openclaw/openclaw.json most recently, the other install's
        // older/mismatched CLI would then correctly refuse to touch a
        // config schema newer than itself -- a real machine hit exactly
        // this: pkg installed a newer npm "latest" and wrote the config,
        // a later dmg install pinned to an older app version, and its
        // model-provisioning step failed silently against that
        // "written by a newer OpenClaw" config. Always resolving to the
        // same channel as the pkg path keeps both installers converging
        // on the same CLI version for the same on-disk state, dmg
        // included.
        //
        // isDebug is forced to false here -- deliberately NOT
        // CLIInstallBuild.isDebug -- so this never resolves to the
        // git/dev channel (installScriptCommand only adds
        // --install-method git when the target is exactly .channel(.dev)):
        // using that here would mean cloning the whole repo and building
        // the CLI from source on first launch, which is what made this
        // take minutes instead of seconds whenever this app binary
        // happened to be a Debug build. CLIInstaller's isDebug-aware
        // channel selection exists for the interactive channel picker
        // developers use on purpose (CLIInstallPrompter), not for a
        // launch meant to look like an ordinary first run.
        let target: CLIInstaller.InstallTarget = .channel(.stable)

        let installed = await CLIInstaller.install(target: target) { [weak self] message in
            traceLog("runIfEligible: install status: \(message)")
            self?.status.step = message
        }
        traceLog("runIfEligible: CLIInstaller.install() returned installed=\(installed)")
        guard installed else {
            AppStateStore.shared.connectionMode = .unconfigured
            return false
        }

        // Deliberately reordered to configure the default model *before*
        // activateLocalGateway() below (was: activate, then configure).
        // openclaw onboard --skip-daemon here only writes settings to disk
        // -- it does not touch any Gateway process -- but a Gateway that is
        // already running by the time it runs read its config once, at its
        // own startup, and does not reload it afterward. Configuring first
        // means whatever process activateLocalGateway() attaches to or
        // starts next reads the *correct* config from its own first boot,
        // instead of racing a config write against a process that already
        // read the old (or default/empty) one. This also matters for a
        // genuinely fresh gateway, not just a stale one: config-after-start
        // silently dropped the default model even on a clean install with
        // nothing left running beforehand.
        if let provider = Self.bundledDefaultProvider() {
            traceLog("runIfEligible: bundledDefaultProvider() found provider id=\(provider.id ?? "nil"), baseURL=\(provider.baseURL), modelID=\(provider.modelID), hasAPIKey=\(provider.apiKey != nil)")
            self.status.step = String(localized: "Configuring default model…")
            let applied = await Self.applyDefaultProvider(provider)
            traceLog("runIfEligible: applyDefaultProvider() returned \(applied)")
        } else {
            traceLog("runIfEligible: bundledDefaultProvider() found no provider (missing/unreadable default-ai-provider.env, or empty baseURL/modelID) -- skipping default model configuration")
        }

        // CLIInstaller.install() above only writes fresh files to
        // managedExecutableLocation() -- it never touches a gateway process
        // that might already be running. The gateway's LaunchAgent is
        // installed with KeepAlive=true (see src/daemon/launchd-plist.ts),
        // so merely stopping the gateway process between launches does not
        // remove it from launchd: launchd silently relaunches it on its
        // own, independent of this app even running, using whatever binary
        // (and whatever config on disk at that moment) happened to be
        // current -- observed in testing as a gateway process that started
        // (via launchd) well before this launch's own install() call above
        // even finished, still running the *previous* version and config.
        // activateLocalGateway() below is attach-first (see
        // GatewayProcessManager.attachExistingGatewayIfAvailable()): it
        // only health-probes an existing listener and never checks that
        // its version or config generation matches what was just written
        // above, so it happily reports success while leaving that stale,
        // launchd-resurrected process in place. Force a restart here,
        // before activateLocalGateway() gets a chance to attach to it,
        // whenever something is already running: launchd re-execs the
        // LaunchAgent's fixed executable path, which now points at the
        // binary install() wrote and reads the config applyDefaultProvider()
        // just wrote above.
        if await GatewayLaunchAgentManager.runningGatewayPID() != nil {
            traceLog("runIfEligible: existing gateway process found after install; forcing restart so it picks up the freshly installed binary and config")
            let restartResult = await GatewayLaunchAgentManager.kickstart()
            traceLog("runIfEligible: GatewayLaunchAgentManager.kickstart() returned \(restartResult ?? "nil (success)")")
        }

        self.status.step = String(localized: "Starting OpenClaw Gateway…")
        let activation = await CLIInstaller.activateLocalGateway()
        traceLog("runIfEligible: CLIInstaller.activateLocalGateway() returned \(activation)")
        guard activation == .ready else {
            AppStateStore.shared.connectionMode = .unconfigured
            return false
        }

        AppStateStore.shared.onboardingSeen = true
        AppNavigationActions.openChat()
        Self.launchLlamaFallbackSetupInBackground()
        return true
    }

    // MARK: - Progress panel

    private func showPanel() {
        traceLog("showPanel: entered")
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
        // This can be the very first window shown on a cold double-click
        // launch, milliseconds into applicationDidFinishLaunching -- unlike
        // OnboardingController.show() (the manual wizard's equivalent window,
        // which has had this app-still-.accessory-at-process-start problem
        // solved for a long time), this path was activating/ordering front
        // without first nudging the activation policy to .regular, and
        // without any retry if the very first activate() this early in the
        // process lifetime is silently dropped by the window server -- both
        // plausible explanations for reports of double-clicking the app
        // showing a Dock icon with no visible window until a second
        // double-click/Dock click. Mirror OnboardingController.show()'s
        // ordering, then reassert focus once more shortly after in case the
        // very first attempt landed too early to take effect.
        DockIconManager.shared.temporarilyShowDock()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.panel = panel
        self.logger.notice("showPanel: panel ordered front, isVisible=\(panel.isVisible, privacy: .public)")
        traceLog("showPanel: panel ordered front, isVisible=\(panel.isVisible)")
        Task { @MainActor [weak self, weak panel] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, let panel, self.panel === panel, !panel.isKeyWindow else { return }
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func closePanel() {
        self.panel?.close()
        self.panel = nil
    }

    /// Called when a Dock/menu-bar-icon reopen (or similar user gesture)
    /// lands while runIfEligible() is still actively mid-flight
    /// (isProvisioning). Calling scheduleFirstRunOnboardingIfNeeded() again
    /// at that point is unsafe: runIfEligible()'s single-flight guard
    /// (hasRunThisLaunch) makes a second concurrent call return false
    /// immediately -- which reads to that caller as "silent bootstrap isn't
    /// going to handle this", and it falls through to the old manual
    /// "Welcome to OpenClaw" wizard, popping that up on top of this
    /// in-flight progress panel. Just reassert this panel's focus instead;
    /// there's nothing else useful to do until runIfEligible() itself
    /// finishes and either opens chat or reverts to the manual wizard on
    /// its own.
    func reactivatePanel() {
        traceLog("reactivatePanel: called, hasPanel=\(self.panel != nil)")
        guard let panel else { return }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
        guard let contents = try? String(contentsOf: envURL, encoding: .utf8) else {
            traceLog("bundledDefaultProvider: could not read \(envURL.path) (file missing from bundle, or unreadable)")
            return nil
        }
        var values: [String: String] = [:]
        for line in contents.split(whereSeparator: \.isNewline) {
            guard let separatorIndex = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<separatorIndex])
            let value = String(line[line.index(after: separatorIndex)...])
            values[key] = value
        }
        let baseURL = values["DEFAULT_AI_BASE_URL"] ?? ""
        let modelID = values["DEFAULT_AI_MODEL"] ?? ""
        guard !baseURL.isEmpty, !modelID.isEmpty else {
            traceLog("bundledDefaultProvider: read \(envURL.path) but baseURL or modelID is empty (baseURLEmpty=\(baseURL.isEmpty), modelIDEmpty=\(modelID.isEmpty)) -- treating as unconfigured")
            return nil
        }
        let providerID = values["DEFAULT_AI_PROVIDER"]
        let apiKey = values["DEFAULT_AI_API_KEY"]
        return DefaultProvider(
            id: (providerID?.isEmpty ?? true) ? nil : providerID,
            baseURL: baseURL,
            modelID: modelID,
            apiKey: (apiKey?.isEmpty ?? true) ? nil : apiKey)
    }

    /// Shells out to the just-installed CLI's own `openclaw onboard
    /// --non-interactive` to write the default model/provider config to
    /// disk. scripts/mac-pkg-postinstall.sh runs a similar command for a
    /// pkg install, but with --install-daemon (not --skip-daemon) --
    /// that script's onboard call is the only thing installing/starting
    /// the Gateway service on that path, so it must manage the daemon
    /// itself. Here, --skip-daemon is intentional and different: this call
    /// now runs *before* activateLocalGateway() (see the reordering
    /// comment at its call site in runIfEligible()), specifically so it
    /// only writes config and never touches any Gateway process itself --
    /// activateLocalGateway() below is solely responsible for starting (or
    /// restarting) the Gateway, and does so only after this config write
    /// has already landed on disk.
    private static func applyDefaultProvider(_ provider: DefaultProvider) async -> Bool {
        let executable = CLIInstaller.managedExecutableLocation()
        guard FileManager.default.isExecutableFile(atPath: executable) else {
            traceLog("applyDefaultProvider: managed executable not found/executable at \(executable)")
            return false
        }
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
        // The API key is passed via the CUSTOM_API_KEY environment variable,
        // never as a --custom-api-key argument: process arguments are
        // world-readable on macOS (any local user can see them in `ps -ef`
        // for as long as onboard runs), environment variables are not.
        // onboard's non-interactive custom-api-key path falls back to
        // CUSTOM_API_KEY when the flag is absent and, in the default
        // (plaintext) secret-input mode, stores the resolved value exactly as
        // it would have stored the flag value
        // (src/commands/onboard-non-interactive/api-keys.ts,
        // resolveNonInteractiveApiKey; local/auth-choice.ts).
        // ShellExecutor treats a non-nil env as a full replacement
        // (.custom), so start from this process's environment.
        var environment: [String: String]? = nil
        if let apiKey = provider.apiKey, !apiKey.isEmpty {
            var merged = ProcessInfo.processInfo.environment
            merged["CUSTOM_API_KEY"] = apiKey
            environment = merged
        }
        let command = AppProfile.current.localCLICommand(prefix: [executable], arguments: arguments)
        // The key no longer travels in `command` (see CUSTOM_API_KEY above),
        // but still never log stdout/stderr verbatim: a misbehaving CLI could
        // in principle echo the key back in its own error text. Strip the
        // literal key value out of anything before it reaches traceLog; the
        // --custom-api-key redaction below is kept as a guard in case the
        // flag is ever reintroduced.
        let redactedCommand = command.enumerated().map { index, token in
            index > 0 && command[index - 1] == "--custom-api-key" ? "<redacted>" : token
        }
        func redactAPIKey(_ text: String) -> String {
            guard let apiKey = provider.apiKey, !apiKey.isEmpty else { return text }
            return text.replacingOccurrences(of: apiKey, with: "<redacted>")
        }
        // One retry after a short delay: observed in testing failing
        // outright (exit 1) a few seconds after CLIInstaller.install()
        // reported success, then succeeding with the exact same command
        // moments later on a subsequent launch -- consistent with the
        // freshly-written CLI/Node install not being fully settled on disk
        // yet (file flush, symlinks, node_modules) at the instant this
        // first runs right after install(). A single short-delay retry
        // covers that transient window without masking a real,
        // deterministic failure (which will fail identically both times,
        // and still gets logged below either way).
        for attempt in 1...2 {
            // runDetailed() (rather than the terser .run()) so a failure's
            // real "[openclaw] Reason: …" text is available here -- .run()'s
            // Response only exposes a generic "exit N"/"timeout"
            // errorMessage, which was observed in testing to give zero
            // insight into why onboard failed.
            let result = await ShellExecutor.runDetailed(command: command, cwd: nil, env: environment, timeout: 60)
            traceLog("applyDefaultProvider: ran (attempt \(attempt)/2) \(redactedCommand.joined(separator: " ")) -> success=\(result.success)")
            if result.success {
                return true
            }
            let combined = result.stdout.isEmpty ? result.stderr : result.stdout
            let summary = TextSummarySupport.summarizeLastLine(redactAPIKey(combined))
                ?? result.errorMessage
                ?? "no output captured"
            traceLog("applyDefaultProvider: failure summary (attempt \(attempt)/2): \(summary)")
            if attempt == 1 {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
        return false
    }

    // MARK: - llama.cpp local-model fallback (installer.env's
    // OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL, deployed by
    // scripts/mac-llama-fallback-setup.sh, bundled by
    // scripts/package-mac-app.sh as Contents/Resources/mac-llama-fallback-setup.sh)

    /// Fires scripts/mac-llama-fallback-setup.sh -- the same script the pkg
    /// installer's postinstall backgrounds -- without awaiting it from
    /// runIfEligible(). That script downloads a GGUF model from HuggingFace
    /// and starts a local llama-server, which can take minutes; it must not
    /// hold up the progress panel or delay AppNavigationActions.openChat()
    /// above. It is entirely best-effort and only ever adds a *backup*
    /// model (--custom-as-backup) once it finishes -- see that script's own
    /// header comment. A missing bundled script (e.g. SKIP_LLAMA_BUNDLE was
    /// set at build time) is a silent no-op here, same as the script's own
    /// early-exit checks would produce.
    static func launchLlamaFallbackSetupInBackground() {
        let scriptURL = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/mac-llama-fallback-setup.sh")
        guard FileManager.default.fileExists(atPath: scriptURL.path) else { return }
        let appPath = Bundle.main.bundleURL.path
        let prefix = CLIInstaller.installPrefix()
        let command = [
            "/bin/bash", scriptURL.path,
            "--app-path", appPath,
            "--prefix", prefix,
        ]
        // Detached: this Task is intentionally never awaited by the caller.
        // The script logs its own progress/failures to
        // ~/Library/Logs/OpenClaw/llama-fallback-setup.log rather than
        // surfacing anything in the UI. It runs on every launch: it is
        // idempotent (a healthy, registered server is left alone), holds a
        // lock against overlapping runs, and resumes an interrupted model
        // download -- so this timeout only bounds one run; a large GGUF
        // download cut short here simply continues on the next launch.
        Task.detached(priority: .background) {
            _ = await ShellExecutor.run(command: command, cwd: nil, env: nil, timeout: 3600)
        }
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
