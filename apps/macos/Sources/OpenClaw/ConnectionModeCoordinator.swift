import Foundation
import OSLog

@MainActor
final class ConnectionModeCoordinator {
    static let shared = ConnectionModeCoordinator()

    struct Transition {
        private(set) var generation: UInt64 = 0
        private(set) var mode: AppState.ConnectionMode?

        mutating func begin(_ mode: AppState.ConnectionMode) -> UInt64 {
            self.generation &+= 1
            self.mode = mode
            return self.generation
        }

        func isCurrent(_ generation: UInt64, mode: AppState.ConnectionMode) -> Bool {
            self.generation == generation && self.mode == mode
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "connection")
    private var transition = Transition()
    private var portSweepTask: Task<Void, Never>?
    private var localDisconnectTask: Task<Void, Never>?
    private var deferredLaunchAgentAuditTask: Task<Void, Never>?

    // Counts overlapping apply() calls rather than a plain Bool: a newer
    // apply() can start (and legitimately supersede an older one via
    // Transition) before that older call has unwound through its own
    // `guard self.transition.isCurrent(...)` early-returns, so a simple
    // "set true on entry, false on exit" flag would flicker false while a
    // still-in-flight apply() from a different caller is the one that
    // actually owns the connection right now.
    private var applyingCount = 0

    /// True while at least one apply() call is in flight. Callers that want
    /// to present UI only once a connection attempt has actually settled
    /// (success or failure) -- rather than racing a blind presentation
    /// against apply()'s own gateway-start/health-probe/ControlChannel
    /// sequence -- check this (see openDashboardOrResumeProvisioning() in
    /// MenuBar.swift, added after a launch showed "Dashboard unavailable"
    /// for several seconds before self-recovering: apply() was still
    /// reattaching/starting the Gateway when a Dock click opened the
    /// Dashboard's WebView against a not-yet-ready endpoint).
    var isApplying: Bool { self.applyingCount > 0 }

    /// Polls until no apply() call is in flight. 200ms matches the poll
    /// interval StatusMenuController.applyStateSideEffects() already uses
    /// to wait out AutoOnboardBootstrap.isProvisioning for the same reason.
    func waitUntilIdle() async {
        while self.isApplying {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    /// Apply the requested connection mode by starting/stopping local gateway,
    /// managing the control-channel SSH tunnel, and cleaning up chat windows/panels.
    func apply(mode: AppState.ConnectionMode, paused: Bool) async {
        self.applyingCount += 1
        defer { self.applyingCount -= 1 }
        traceLog("ConnectionModeCoordinator.apply: entered, mode=\(mode), paused=\(paused)")
        self.portSweepTask?.cancel()
        self.localDisconnectTask?.cancel()
        let hostsLocalGateway = AppStateStore.shared.hostsLocalGatewayWithRemotePrimary
        let previousMode = self.transition.mode
        let applyGeneration = self.transition.begin(mode)
        if mode != .remote || !hostsLocalGateway {
            WebChatManager.shared.closeLocalGatewayWindows()
            let disconnect = Task {
                await MacGatewayConnectionFleet.shared.disconnectLocal(ifCurrent: { !Task.isCancelled })
            }
            self.localDisconnectTask = disconnect
            await disconnect.value
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
        }
        if let previousMode, previousMode != mode {
            GatewayProcessManager.shared.clearLastFailure()
            NodesStore.shared.lastError = nil
        }
        if mode != .remote {
            _ = await NodeServiceManager.stop()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            NodesStore.shared.lastError = nil
            await RemoteTunnelManager.shared.stopAll()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            WebChatManager.shared.resetPrimaryConnections()
        }

        switch mode {
        case .unconfigured:
            GatewayProcessManager.shared.stop()
            await ControlChannel.shared.disconnect()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }

        case .local:
            traceLog("ConnectionModeCoordinator.apply: awaiting applyLocalMode()")
            await self.applyLocalMode(paused: paused, generation: applyGeneration)
            traceLog("ConnectionModeCoordinator.apply: applyLocalMode() returned")
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }

        case .remote:
            await self.applyLocalGateway(
                mode: mode,
                paused: paused,
                hostsLocalGateway: hostsLocalGateway,
                generation: applyGeneration)
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            WebChatManager.shared.resetPrimaryConnections()

            do {
                NodesStore.shared.lastError = nil
                let nodeError = await NodeServiceManager.start()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                if let error = nodeError {
                    NodesStore.shared.lastError = "Node service start failed: \(error)"
                }
                _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                await ControlChannel.shared.configure()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            } catch {
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                self.logger.error("remote tunnel/configure failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.portSweepTask = Task {
            await PortGuardian.shared.sweep(mode: mode, hostsLocalGateway: hostsLocalGateway)
        }
    }

    private func applyLocalMode(paused: Bool, generation: UInt64) async {
        traceLog("applyLocalMode: awaiting applyLocalGateway()")
        await self.applyLocalGateway(mode: .local, paused: paused, hostsLocalGateway: false, generation: generation)
        traceLog("applyLocalMode: applyLocalGateway() returned")
        guard self.transition.isCurrent(generation, mode: .local) else { return }
        traceLog("applyLocalMode: awaiting ControlChannel.configure()")
        await ControlChannel.shared.configure()
        traceLog("applyLocalMode: ControlChannel.configure() returned")
    }

    private func applyLocalGateway(
        mode: AppState.ConnectionMode,
        paused: Bool,
        hostsLocalGateway: Bool,
        generation: UInt64) async
    {
        if GatewayAutostartPolicy.shouldStartGateway(mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway) {
            traceLog("applyLocalGateway: setActive(true)")
            GatewayProcessManager.shared.setActive(true)
            traceLog("applyLocalGateway: awaiting waitForStartupAttempt()")
            await GatewayProcessManager.shared.waitForStartupAttempt()
            traceLog("applyLocalGateway: waitForStartupAttempt() returned")
            guard self.transition.isCurrent(generation, mode: mode) else { return }
            // Relaunch fast path: startup already attached to a Gateway that
            // passed its health probe (status .attachedExisting), so there is
            // nothing to wait for before presenting the dashboard. The
            // LaunchAgent audit below (ensureLaunchAgentEnabledIfNeeded ->
            // `openclaw gateway status --json` through Node, measured at
            // 1.5-2.3s per launch) only confirms/repairs persistence; for a
            // healthy attach it returns "skipped". Run it right after instead
            // of in front of the dashboard: same audit, same repair behavior
            // (config drift, port change, stale plist -> reinstall + readiness
            // recovery), just off the critical path. Local mode only; the
            // remote-with-local-gateway path keeps the original ordering.
            if mode == .local,
               GatewayAutostartPolicy.shouldEnsureLaunchAgent(
                   mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway),
               case .attachedExisting = GatewayProcessManager.shared.status
            {
                traceLog("applyLocalGateway: attached to a healthy gateway; deferring LaunchAgent audit")
                traceLog("applyLocalGateway: awaiting waitForGatewayReady()")
                _ = await GatewayProcessManager.shared.waitForGatewayReady(launchAgentInstalled: false)
                traceLog("applyLocalGateway: waitForGatewayReady() returned")
                guard self.transition.isCurrent(generation, mode: mode) else { return }
                self.scheduleDeferredLaunchAgentAudit(mode: mode, generation: generation)
                return
            }
            var launchAgentInstalled = false
            if GatewayAutostartPolicy.shouldEnsureLaunchAgent(
                mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway)
            {
                traceLog("applyLocalGateway: awaiting ensureLaunchAgentEnabledIfNeeded()")
                launchAgentInstalled = await GatewayProcessManager.shared.ensureLaunchAgentEnabledIfNeeded()
                traceLog("applyLocalGateway: ensureLaunchAgentEnabledIfNeeded() returned installed=\(launchAgentInstalled)")
            }
            guard self.transition.isCurrent(generation, mode: mode) else { return }
            // Finish persistence before readiness so a newer lifecycle cannot clear its repair marker.
            traceLog("applyLocalGateway: awaiting waitForGatewayReady()")
            _ = await GatewayProcessManager.shared.waitForGatewayReady(
                launchAgentInstalled: launchAgentInstalled)
            traceLog("applyLocalGateway: waitForGatewayReady() returned")
            guard self.transition.isCurrent(generation, mode: mode) else { return }
        } else {
            GatewayProcessManager.shared.stop()
            await GatewayProcessManager.shared.waitForStartupAttempt()
        }
    }

    /// Runs the LaunchAgent persistence audit that the relaunch fast path in
    /// applyLocalGateway() took off the critical path, in the same order the
    /// normal path uses (ensure, then readiness) so a reinstall it triggers
    /// still gets its readiness/recovery pass. Superseded by any newer apply().
    private func scheduleDeferredLaunchAgentAudit(mode: AppState.ConnectionMode, generation: UInt64) {
        self.deferredLaunchAgentAuditTask?.cancel()
        self.deferredLaunchAgentAuditTask = Task { @MainActor [weak self] in
            guard let self, self.transition.isCurrent(generation, mode: mode) else { return }
            traceLog("deferredLaunchAgentAudit: awaiting ensureLaunchAgentEnabledIfNeeded()")
            let installed = await GatewayProcessManager.shared.ensureLaunchAgentEnabledIfNeeded()
            traceLog("deferredLaunchAgentAudit: ensureLaunchAgentEnabledIfNeeded() returned installed=\(installed)")
            guard !Task.isCancelled, self.transition.isCurrent(generation, mode: mode) else { return }
            _ = await GatewayProcessManager.shared.waitForGatewayReady(launchAgentInstalled: installed)
            traceLog("deferredLaunchAgentAudit: waitForGatewayReady() returned")
        }
    }
}
