import AppKit
import Darwin
import Dispatch
import Foundation
import OpenClawKit
import OSLog
import SwiftUI

// Temporary file-based diagnostic logging, added because os.Logger's
// .notice() calls placed at these same call sites (see the comments on
// AutoOnboardBootstrap.logger and AppDelegate.logger) have not shown up in
// either `log stream` or `log show --last` output across several real test
// launches, despite those call sites being confirmed reached (other
// logging from later in the very same functions does show up) and the
// string literals being confirmed present in the built binary. This
// sidesteps whatever about the unified-logging path is swallowing them by
// writing straight to a plain file instead, which has no comparable
// ambiguity around log level, predicate, or store-persistence timing.
// Safe to remove, along with its call sites, once the "Setting up
// OpenClaw..." panel-timing question this exists to answer is resolved.
func traceLog(_ message: String) {
    let path = NSHomeDirectory() + "/Library/Logs/OpenClaw/launch-trace.log"
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    let line = "\(formatter.string(from: Date())) [pid \(ProcessInfo.processInfo.processIdentifier)] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

/// Routes private maintenance commands before SwiftUI constructs or activates the application.
@main
enum OpenClawProcessMain {
    static func main() {
        if let status = OpenClawProcessEntrypoint.run(arguments: CommandLine.arguments, launchApplication: {
            OpenClawApp.main()
        }) {
            Darwin.exit(status)
        }
    }
}

enum OpenClawProcessEntrypoint {
    static func run(arguments: [String], launchApplication: () -> Void) -> Int32? {
        if let status = ElevationExclusiveRename.runIfRequested(arguments: arguments) {
            return status
        }
        if let status = ElevationFilesystemSync.runIfRequested(arguments: arguments) {
            return status
        }
        launchApplication()
        return nil
    }
}

struct OpenClawApp: App {
    // periphery:ignore - SwiftUI installs the application delegate through this property wrapper.
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openSettings) private var openSettings
    @State private var state: AppState
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app")
    private var tailscaleService: TailscaleService {
        .shared
    }

    init() {
        let launchPlan = AppLaunchRuntimePlan.current
        if let error = AppProfile.current.validationError {
            if launchPlan.isElevationHost {
                fputs("OpenClaw elevation host profile is invalid: \(error.localizedDescription)\n", stderr)
                Darwin.exit(2)
            }
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "OpenClaw profile is invalid"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            Darwin.exit(2)
        }
        if AppProfile.current.isActive,
           !DeviceIdentityStore.configureStateDirectory(OpenClawPaths.stateDirURL)
        {
            fatalError("Device identity state root was already used before app profile configuration")
        }
        guard GatewayTLSStore.configureKeychainServiceSuffix(AppProfile.current.keychainServiceSuffix) else {
            fatalError("Gateway TLS Keychain namespace was already used by another app profile")
        }
        OpenClawLogging.bootstrapIfNeeded()

        Self.applyAttachOnlyOverrideIfNeeded(plan: launchPlan)
        _state = State(initialValue: AppStateStore.shared)
    }

    var body: some Scene {
        // Register before any window is opened, including connection recovery from the dashboard.
        let openSettings = self.openSettings
        ConnectionWindowOpener.shared.register {
            openSettings()
        }
        // The native Connection window is a standard macOS Settings window: toolbar tabs, fixed width,
        // content-sized height per tab. Cmd-, still opens Dashboard settings via the replaced command.
        return Settings {
            ConnectionWindow(state: self.state)
                .environment(self.tailscaleService)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Gateway Window…") {
                    AppNavigationActions.newGatewayWindow()
                }
                .keyboardShortcut("n", modifiers: .command)

                if !self.state.nativeExperienceEnabled {
                    Button("New Thread") {
                        DashboardManager.shared.dispatchNativeCommand(.newSession)
                    }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                }
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") {
                    AppNavigationActions.openSettings()
                }
                .keyboardShortcut(",", modifiers: .command)

                Button("Connection…") {
                    AppNavigationActions.openConnection()
                }
            }
            CommandGroup(replacing: .appInfo) {
                Button("About OpenClaw") {
                    AppNavigationActions.openAbout()
                }
            }
            SidebarCommands()
            if !self.state.nativeExperienceEnabled {
                CommandMenu("Navigate") {
                    Button("Back") {
                        DashboardManager.shared.navigateBack()
                    }
                    .keyboardShortcut("[", modifiers: .command)

                    Button("Forward") {
                        DashboardManager.shared.navigateForward()
                    }
                    .keyboardShortcut("]", modifiers: .command)

                    Divider()

                    Button("Command Palette…") {
                        DashboardManager.shared.dispatchNativeCommand(.commandPalette)
                    }
                    .keyboardShortcut("k", modifiers: .command)
                }
            }
            DashboardGatewayCommands()
        }
    }

    private static func applyAttachOnlyOverrideIfNeeded(plan: AppLaunchRuntimePlan) {
        guard plan.attachOnly else { return }
        if let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride() {
            self.logger.error("attach-only flag failed: \(error, privacy: .public)")
            return
        }
        self.logger.info("attach-only flag enabled")
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // Temporary instrumentation, see AutoOnboardBootstrap.logger's comment.
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-launch")
    private var state: AppState?
    private var statusMenuController: StatusMenuController?
    private lazy var dockMenu = AppDockMenu(
        openDashboard: { [weak self] in self?.openDashboardOrResumeProvisioning() },
        openGateway: { AppNavigationActions.openGateway($0) },
        openSettings: { AppNavigationActions.openSettings() })
    private var terminationCleanupTask: Task<Void, Never>?
    private var terminationDeadlineTask: Task<Void, Never>?
    private var terminationCleanupFinished = false
    private var profileInstanceLock: AppInstanceLock?
    private let webChatAutoLogger = Logger(subsystem: "ai.openclaw", category: "Chat")
    private static func cleanUpProcesses() async {
        let execHostCleanup = ExecApprovalsPromptServer.shared.stop()
        let macControlCleanup = MacControlServer.shared.stop()
        // Start tunnel retirement before helper drains can consume the quit deadline.
        async let tunnelCleanup: Void = RemoteTunnelManager.shared.shutdown()
        async let gatewayCleanup: Void = GatewayConnection.shared.shutdown()
        async let profileCleanup = MacGatewayConnectionFleet.shared.shutdown()
        // CUA must drain its worker before the node closes the daemon socket.
        if AppLaunchRuntimePlan.current.allowsCuaComputerControl {
            await CuaDriverHostCoordinator.shared.shutdown()
        }
        await TalkMLXSpeechSynthesizer.shared.shutdown()
        await MacNodeModeCoordinator.shared.stopAndWait()
        _ = await (tunnelCleanup, gatewayCleanup, profileCleanup)
        await execHostCleanup?.value
        await macControlCleanup?.value
    }

    var openDashboardAction: @MainActor () -> Void = { AppNavigationActions.openDashboard() }
    let updaterController: UpdaterProviding

    override init() {
        let environment = ProcessInfo.processInfo.environment
        let hasReplacementMetadata = ApplicationRelocator.hasReplacementHandoffMetadata(
            environment: environment)
        let isReplacementHandoff = hasReplacementMetadata &&
            ApplicationRelocator.acceptReplacementHandoff(environment: environment)
        if hasReplacementMetadata, !isReplacementHandoff {
            fputs("OpenClaw replacement handoff authentication failed.\n", stderr)
            Darwin.exit(2)
        }
        let ownership = AppInstanceLock.acquire(
            url: AppProfile.current.instanceLockURL(),
            waitMilliseconds: isReplacementHandoff ? 5000 : 0)
        if let exitCode = Self.processExitCode(for: ownership) {
            fputs("OpenClaw profile is already running.\n", stderr)
            Darwin.exit(exitCode)
        }
        var profileInstanceLock: AppInstanceLock?
        var instanceOwnershipFailure: String?
        switch ownership {
        case let .acquired(lock):
            profileInstanceLock = lock
        case .busy:
            break
        case let .failed(message):
            instanceOwnershipFailure = message
        }
        self.profileInstanceLock = profileInstanceLock
        self.updaterController = instanceOwnershipFailure == nil
            ? makeUpdaterController()
            : DisabledUpdaterController()
        super.init()
        if let instanceOwnershipFailure {
            if AppLaunchRuntimePlan.current.isElevationHost {
                fputs(
                    "OpenClaw elevation host could not claim its instance lock: \(instanceOwnershipFailure)\n",
                    stderr)
                Darwin.exit(2)
            }
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "OpenClaw could not claim its instance lock"
            alert.informativeText = instanceOwnershipFailure
            alert.runModal()
            Darwin.exit(2)
        }
    }

    static func processExitCode(for ownership: AppInstanceLockAcquisition) -> Int32? {
        if case .busy = ownership { return 0 }
        return nil
    }

    func applicationWillFinishLaunching(_: Notification) {
        // URL/reopen callbacks can create the dashboard before didFinishLaunching.
        DashboardManager.shared.configure(updater: self.updaterController)
    }

    func applicationDockMenu(_: NSApplication) -> NSMenu? {
        self.dockMenu.menu(
            entries: DashboardManager.shared.gatewayEntries,
            selectedTarget: AppNavigationActions.selectedGatewayTarget)
    }

    func application(_: NSApplication, open urls: [URL]) {
        guard !AppLaunchRuntimePlan.current.isElevationHost else { return }
        Task { @MainActor in
            for url in urls {
                await DeepLinkHandler.shared.handle(url: url)
            }
        }
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows _: Bool) -> Bool {
        // Reopening is explicit user intent even after a background-only launch.
        guard !AppLaunchRuntimePlan.current.isElevationHost else { return false }
        self.openDashboardOrResumeProvisioning()
        return false
    }

    // Both a Dock-icon reopen click and the Dock right-click menu's "Open
    // Dashboard" item ultimately want the same thing here: land the user
    // somewhere useful, not necessarily literally the Dashboard window if
    // this launch hasn't actually gotten there yet. Either can land in the
    // brief window before applicationDidFinishLaunching's own scheduled
    // provisioning Task has actually started running (connectionMode still
    // .unconfigured), or while AutoOnboardBootstrap is actively mid-flight
    // (isProvisioning) -- opening the Dashboard unconditionally in either
    // case raced both of those into flashing up "Dashboard unavailable,
    // could not connect" well before the bootstrap's own "Setting up
    // OpenClaw..." progress panel ever got a chance to show, even though
    // provisioning was already under way or about to be. Route through the
    // same check applicationDidFinishLaunching itself uses instead of
    // opening the Dashboard blind -- scheduleFirstRunOnboardingIfNeeded()
    // is safe to call again here even if the launch-time Task already
    // claimed it (AutoOnboardBootstrap's own hasRunThisLaunch guard makes a
    // second call a no-op), and calling it from this explicit user gesture
    // instead of only waiting on that Task is what gets the progress panel
    // showing sooner rather than later.
    /// Internal (not private): also called from StatusMenuController,
    /// StatusMenuRenderer, and DeepLinks, whose menu-bar-icon click, dropdown
    /// "Dashboard" item, and openclaw://dashboard link can each fire in the same
    /// early post-launch window as the Dock-reopen case above, and want the same
    /// fallback instead of a raced-open Dashboard.
    func openDashboardOrResumeProvisioning() {
        traceLog("openDashboardOrResumeProvisioning: called, isProvisioningOrUnconfigured=\(self.isProvisioningOrUnconfigured), isProvisioning=\(AutoOnboardBootstrap.shared.isProvisioning)")
        guard self.isProvisioningOrUnconfigured else {
            self.openDashboardAction()
            return
        }
        // A reopen landing while AutoOnboardBootstrap's own runIfEligible()
        // is still actively running must not call
        // scheduleFirstRunOnboardingIfNeeded() again -- its single-flight
        // guard would make that second call fall through to the manual
        // wizard instead of a no-op, popping "Welcome to OpenClaw" up on
        // top of the still-in-flight "Setting up OpenClaw..." panel. Just
        // bring that existing panel back into focus instead.
        guard !AutoOnboardBootstrap.shared.isProvisioning else {
            traceLog("openDashboardOrResumeProvisioning: bringing existing panel back via reactivatePanel()")
            AutoOnboardBootstrap.shared.reactivatePanel()
            return
        }
        Task { @MainActor in
            await self.scheduleFirstRunOnboardingIfNeeded()
        }
    }

    private var isProvisioningOrUnconfigured: Bool {
        AutoOnboardBootstrap.shared.isProvisioning || self.state?.connectionMode == .unconfigured
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        false
    }

    @MainActor
    func applicationDidFinishLaunching(_: Notification) {
        #if DEBUG
        if CommandLine.arguments.contains("--swarm-chat-fixture") {
            DockIconManager.shared.updateDockVisibility()
            WebChatManager.shared.showSwarmFixture()
            return
        }
        #endif
        // Temporary instrumentation, see AutoOnboardBootstrap.logger's comment --
        // pins down whether a slow-to-appear "Setting up OpenClaw..." panel is
        // waiting on this function's own synchronous work to finish, or on
        // something after runIfEligible() actually starts. Safe to remove once
        // that's confirmed.
        Self.logger.notice("applicationDidFinishLaunching: entered")
        traceLog("applicationDidFinishLaunching: entered")
        let launchPlan = AppLaunchRuntimePlan.current
        if !AppProfile.current.isActive, !launchPlan.isElevationHost {
            switch ApplicationRelocator.handleLaunch() {
            case .terminating:
                return
            case let .continueLaunch(startUpdater):
                if startUpdater, launchPlan.allowsUpdater {
                    if OpenClawConfigFile.gatewayUpdateChannel() == nil {
                        self.updaterController.startAfterResolvingGatewayUpdateChannel()
                    } else {
                        self.updaterController.start()
                    }
                }
            }
        }
        // Remote startup can spawn an SSH child. Admit tunnel work only after the
        // singleton check so a short-lived handoff process cannot orphan that child.
        GatewayEndpointStore.admitPrimaryAppLaunch()
        GatewayConnectivityCoordinator.shared.start()
        self.state = AppStateStore.shared
        if let state {
            MacNodeModeCoordinator.prepareNodeIdentityProfile(
                isExistingInstallation: state.onboardingSeen || state.connectionMode != .unconfigured)
        }
        DockIconManager.shared.updateDockVisibility()
        if launchPlan.allowsInteractiveServices, let state {
            let controller = StatusMenuController(state: state, updater: self.updaterController)
            controller.start()
            self.statusMenuController = controller
        }
        if let state {
            let shouldWaitForConnection = state.connectionMode != .unconfigured
            if !shouldWaitForConnection, launchPlan.allowsAutomaticPresentation {
                Self.logger.notice("applicationDidFinishLaunching: creating auto-onboard Task")
                traceLog("applicationDidFinishLaunching: creating auto-onboard Task")
                Task { @MainActor in
                    Self.logger.notice("applicationDidFinishLaunching: auto-onboard Task started running")
                    traceLog("applicationDidFinishLaunching: auto-onboard Task started running")
                    await self.scheduleFirstRunOnboardingIfNeeded()
                }
            }
            Task { @MainActor in
                traceLog("applicationDidFinishLaunching: connection Task started running, shouldWaitForConnection=\(shouldWaitForConnection), connectionMode=\(state.connectionMode)")
                // Validate PATH selection before local startup. Existing installs may not
                // have the validation cache yet, and a stale external CLI must not win.
                if state.connectionMode == .local ||
                    (state.connectionMode == .remote && state.hostsLocalGatewayWithRemotePrimary)
                {
                    traceLog("applicationDidFinishLaunching: awaiting CLIInstaller.status()")
                    _ = await CLIInstaller.status()
                    traceLog("applicationDidFinishLaunching: CLIInstaller.status() returned")
                }
                // Decide onboarding/reprovisioning *before* asking ConnectionModeCoordinator
                // to stand up (or reattach to) a Gateway for this mode -- moved ahead of the
                // apply() call below (was after it). Measured root cause of the "Setting up
                // OpenClaw..." panel taking 40+ seconds to appear, and of a Dock-icon click
                // in that window hitting "Dashboard unavailable": connectionMode can read
                // .local here (a prior run's persisted state, or a reinstall over preferences
                // that still say so) while nothing is actually installed yet -- a first-ever
                // launch, or one after a reinstall. ConnectionModeCoordinator.apply() has no
                // way to tell "not installed yet" apart from "installed but briefly not
                // running", so it patiently retried a Gateway nothing had attempted to start,
                // for GatewayLaunchAgentManager.startupMigrationTolerance's full first-run
                // grace window (120s, observed cut short around 42-48s) -- entirely blocking
                // scheduleFirstRunOnboardingIfNeeded() (and therefore this panel) and this
                // app's own Dashboard-open guard (isProvisioningOrUnconfigured only becomes
                // true once AutoOnboardBootstrap.runIfEligible() itself starts) for that whole
                // window. AutoOnboardBootstrap has its own, separate, and much faster path to
                // actually install/start a Gateway (CLIInstaller.activateLocalGateway(),
                // inside runIfEligible()) -- there is nothing useful for
                // ConnectionModeCoordinator.apply() to wait on here until that has had a
                // chance to run. Calling scheduleFirstRunOnboardingIfNeeded() first costs
                // nothing when this launch turns out to already be genuinely ready (its own
                // CLIInstaller.managedStatus() check is fast and it returns immediately);
                // apply() below then finds a real, already-running Gateway to attach to
                // instead of one nothing has tried to start, resolving in seconds either way.
                if launchPlan.allowsAutomaticPresentation, shouldWaitForConnection {
                    traceLog("applicationDidFinishLaunching: shouldWaitForConnection path calling scheduleFirstRunOnboardingIfNeeded() (before ConnectionModeCoordinator.apply())")
                    await self.scheduleFirstRunOnboardingIfNeeded()
                }
                traceLog("applicationDidFinishLaunching: awaiting ConnectionModeCoordinator.apply()")
                await ConnectionModeCoordinator.shared.apply(
                    mode: state.connectionMode,
                    paused: state.isPaused)
                traceLog("applicationDidFinishLaunching: ConnectionModeCoordinator.apply() returned")
                guard launchPlan.allowsAutomaticPresentation else { return }
                // Attachment must settle before deciding whether this app needs to install a CLI.
                let postUpdateStarted = PostUpdateController.shared.startIfNeeded()
                // Only when this launch was already configured (shouldWaitForConnection):
                // a genuinely fresh/unconfigured launch is already owned end-to-end by the
                // sibling Task above (scheduleFirstRunOnboardingIfNeeded() ->
                // AutoOnboardBootstrap). Running this separate, older CLI-install-prompting
                // path here too raced a second, independent install-cli.sh against
                // AutoOnboardBootstrap's own on a fresh install -- observed in testing as
                // Node quietly starting to install in the background with no progress
                // panel (this path has none), before AutoOnboardBootstrap's own panel and
                // install finally appeared and finished the job. Both paths reading/writing
                // the same AppStateStore.connectionMode/onboardingSeen made the race
                // possible: AutoOnboardBootstrap setting connectionMode = .local partway
                // through its own run could make checkAndPromptIfNeededAsync's guards pass
                // on a stale onboardingSeen value before AutoOnboardBootstrap ever reaches
                // its own onboardingSeen = true.
                if shouldWaitForConnection, !postUpdateStarted {
                    CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "launch")
                }
            }
        }
        // Deferred (was synchronous, inline, right here) -- these are all
        // independent background services with no ordering dependency on
        // each other or on what follows, but each one starting synchronously
        // added to a chain that had to run to completion before this
        // function returned control to the run loop. Only once
        // applicationDidFinishLaunching actually returns does the run loop
        // get a chance to dispatch the auto-onboard Task created above, so
        // that Task (and its "Setting up OpenClaw..." panel) was queued
        // behind all of this rather than getting to run first. Moving it
        // into its own Task lets it run a beat later instead, off the
        // critical path to that panel appearing.
        Task { @MainActor [weak self] in
            traceLog("applicationDidFinishLaunching: deferred background-services Task started running")
            TerminationSignalWatcher.shared.start()
            MacNodeModeCoordinator.shared.start()
            guard launchPlan.allowsInteractiveServices else { return }
            GatewaysMainMenu.shared.install()
            BackgroundSessionNotifications.shared.start()
            NodePairingApprovalPrompter.shared.start()
            DevicePairingApprovalPrompter.shared.start()
            ExecApprovalsPromptServer.shared.start()
            MacControlServer.shared.start()
            ExecApprovalsGatewayPrompter.shared.start()
            if let state = self?.state {
                CookieSyncManager.shared.start(state: state)
            }
            VoiceWakeGlobalSettingsSync.shared.start()
            QuickChatController.shared.start()
        }
        Task { PresenceReporter.shared.start() }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        Task { await PortGuardian.shared.reapOrphanedTunnels() }
        AppStateStore.shared.applyComputerControlHostState()
        if launchPlan.allowsAutomaticPresentation {
            Task {
                try? await Task.sleep(for: .seconds(2))
                // Skip while AutoOnboardBootstrap is actively provisioning this
                // launch: connectionMode can already read .local (or a stale
                // .local from an earlier run) before the Gateway it's still
                // installing/starting is actually reachable, so opening the
                // dashboard here raced it into showing a "Dashboard unavailable,
                // could not connect" window ahead of the bootstrap's own
                // progress panel and successful completion. AutoOnboardBootstrap
                // opens chat itself once it's actually done, so there's nothing
                // for this to add while it's in flight. Also skip if onboarding
                // was never actually completed -- a failed auto-install falls
                // through to the manual "Welcome to OpenClaw" wizard instead
                // (AppStateStore.onboardingSeen stays false), and opening the
                // dashboard here would repeat the exact "Dashboard unavailable"
                // flash this guard exists to avoid.
                guard !AutoOnboardBootstrap.shared.isProvisioning,
                      AppStateStore.shared.onboardingSeen
                else { return }
                // Bring the dashboard to the front on a normal, already-configured
                // launch (was: DashboardManager.shared.preloadIfConfigured(), which
                // deliberately loads in the background and never orders the window
                // front -- see its own doc comment). That made every ordinary
                // double-click launch open silently into the background/menu bar,
                // needing a second, separate click (Dock reopen) to actually see
                // the main window -- not matching how a double-click behaves for
                // most macOS apps.
                traceLog("applicationDidFinishLaunching: 2s auto-present Task opening dashboard")
                AppNavigationActions.openDashboard(userGesture: false)
            }
        }

        #if DEBUG
        // Screenshot/demo helper: show the pairing panel with sample requests.
        if launchPlan.allowsAutomaticPresentation,
           ProcessInfo.processInfo.environment["OPENCLAW_DEBUG_PAIRING_DEMO"] == "1"
        {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                DebugActions.showPairingPanelDemo()
            }
        }
        #endif
        // Developer/testing helper: auto-open chat when launched with --chat (or legacy --webchat).
        if launchPlan.shouldAutoOpenChat(arguments: CommandLine.arguments) {
            self.webChatAutoLogger.debug("Auto-opening chat via CLI flag")
            AppNavigationActions.openChat()
        }
        if launchPlan.shouldAutoOpenDashboard(arguments: CommandLine.arguments) {
            self.webChatAutoLogger.info("Auto-opening dashboard via CLI flag")
            AppNavigationActions.openDashboard(userGesture: false)
        }
    }

    func applicationWillTerminate(_: Notification) {
        BackgroundSessionNotifications.shared.stop()
        self.statusMenuController?.stop()
        QuickChatController.shared.stop()
        PresenceReporter.shared.stop()
        NodePairingApprovalPrompter.shared.stop()
        DevicePairingApprovalPrompter.shared.stop()
        ExecApprovalsPromptServer.shared.stop()
        MacControlServer.shared.stop()
        ExecApprovalsGatewayPrompter.shared.stop()
        MacNodeModeCoordinator.shared.stop()
        CookieSyncManager.shared.stop()
        TerminationSignalWatcher.shared.stop()
        VoiceWakeGlobalSettingsSync.shared.stop()
        DashboardManager.shared.close()
        WebChatManager.shared.close()
    }

    static func requestTermination() {
        // terminateLater spins a nested AppKit loop. Calling terminate on the main
        // dispatch queue prevents that loop from running MainActor cleanup or its deadline.
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0, inModes: [.common])
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if self.terminationCleanupFinished {
            return .terminateNow
        }
        guard self.terminationCleanupTask == nil else {
            return .terminateLater
        }
        // AppKit will not tear down onboarding while its sheet remains attached.
        // Retire it before terminateLater starts the asynchronous cleanup loop.
        OnboardingController.shared.close()
        self.terminationCleanupTask = Task { @MainActor [weak self] in
            async let processCleanupResult: Void = Self.cleanUpProcesses()
            async let bridgeCleanupResult: Void = PeekabooBridgeHostCoordinator.shared.shutdown()
            _ = await (processCleanupResult, bridgeCleanupResult)
            self?.finishTerminationCleanup(for: sender)
        }
        self.terminationDeadlineTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(AppTerminationTiming.cleanupDeadlineSeconds))
            guard !Task.isCancelled else { return }
            self?.finishTerminationCleanup(for: sender)
        }
        return .terminateLater
    }

    private func finishTerminationCleanup(for sender: NSApplication) {
        guard !self.terminationCleanupFinished else { return }
        // Cleanup may ignore cancellation while transport or input teardown is stuck.
        // The deadline replies without awaiting that loser; this gate keeps the reply single.
        self.terminationCleanupFinished = true
        self.terminationCleanupTask?.cancel()
        self.terminationDeadlineTask?.cancel()
        self.terminationCleanupTask = nil
        self.terminationDeadlineTask = nil
        sender.reply(toApplicationShouldTerminate: true)
    }

    static func shouldPresentScheduledFirstRunOnboarding(onboardingSeen: Bool) -> Bool {
        !onboardingSeen
    }

    private func scheduleFirstRunOnboardingIfNeeded() async {
        let connectionMode = AppStateStore.shared.connectionMode
        let onboardingSeen = AppStateStore.shared.onboardingSeen
        // connectionMode/onboardingSeen live in UserDefaults keyed by bundle
        // id, which survives deleting OpenClaw.app and reinstalling a fresh
        // copy in its place (macOS does not clear a bundle id's preferences
        // just because the .app was trashed) -- so these flags alone can
        // say "already configured" on a machine that's actually back to a
        // blank slate. Only trust them once the managed CLI install is
        // confirmed still there; otherwise fall through exactly as if this
        // were a genuinely fresh launch.
        if connectionMode != .unconfigured, onboardingSeen,
           case .ready = await CLIInstaller.managedStatus()
        {
            OnboardingController.markComplete()
            return
        }
        // Onboarding hasn't completed, or the flags saying it did no longer
        // match reality (see above): try the silent bootstrap first -- same
        // CLI/Gateway/model steps a pkg install's postinstall script does,
        // just run from inside the app so a plain dmg install (or a
        // reinstall over stale preferences) gets them too, with no manual
        // clicks. AutoOnboardBootstrap does its own reality check and
        // idempotent re-run internally, and reverts all app state and
        // returns false on any real failure, so falling through to the
        // normal wizard below is exactly what would have happened without
        // this existing.
        if await AutoOnboardBootstrap.shared.runIfEligible() {
            return
        }
        self.scheduleFirstRunOnboardingPresentation()
    }

    private func scheduleFirstRunOnboardingPresentation() {
        let seenVersion = AppDefaults.standard.integer(forKey: onboardingVersionKey)
        let shouldShow = seenVersion < currentOnboardingVersion || !AppStateStore.shared.onboardingSeen
        guard shouldShow else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard Self.shouldPresentScheduledFirstRunOnboarding(
                onboardingSeen: AppStateStore.shared.onboardingSeen)
            else { return }
            OnboardingController.shared.show()
        }
    }
}
