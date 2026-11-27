import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite
struct GatewayConnectionClientCapabilitiesTests {
    @Test
    func `operator connection advertises plugin approval delivery`() {
        #expect(GatewayConnection.operatorClientCaps.contains(OpenClawGatewayClientCapability.pluginApprovals))
    }
}
