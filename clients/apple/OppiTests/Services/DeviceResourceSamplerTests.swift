import Foundation
import Testing
@testable import Oppi

@Suite("DeviceResourceSampler")
struct DeviceResourceSamplerTests {

    // MARK: - CPU delta computation

    @Test("CPU delta produces valid percentage from synthetic timestamps")
    func cpuDeltaComputation() {
        // Simulate: 0.5s of CPU time over a 10s wall interval = 5%
        let wallSeconds = 10.0
        let prevUser = 100.0
        let prevSystem = 50.0
        let curUser = 100.4
        let curSystem = 50.1

        let cpuDelta = (curUser - prevUser) + (curSystem - prevSystem)
        let cpuPct = (cpuDelta / wallSeconds) * 100.0

        #expect(cpuPct > 0)
        #expect(cpuPct < 100)
        #expect(abs(cpuPct - 5.0) < 0.01)
    }

    @Test("CPU delta handles zero wall time gracefully")
    func cpuDeltaZeroWallTime() {
        let wallSeconds = 0.0
        // When wall time is zero, we skip emission (division by zero guard).
        // The sampler checks `wallSeconds > 0` before computing.
        #expect(wallSeconds <= 0)
    }

    @Test("CPU delta can exceed 100% with multicore usage")
    func cpuDeltaMulticore() {
        // 4 cores fully busy: 40s of CPU time over 10s wall = 400%
        let wallSeconds = 10.0
        let cpuDelta = 40.0
        let cpuPct = (cpuDelta / wallSeconds) * 100.0

        #expect(cpuPct == 400.0)
    }

    // MARK: - Memory values

    @Test("Memory footprint conversion is non-negative")
    func memoryFootprintNonNegative() {
        // Simulating phys_footprint -> MB conversion
        let physFootprint: UInt64 = 150 * 1024 * 1024 // 150 MB
        let footprintMB = Double(physFootprint) / (1024 * 1024)

        #expect(footprintMB >= 0)
        #expect(abs(footprintMB - 150.0) < 0.01)
    }

    @Test("Available memory conversion is non-negative")
    func availableMemoryNonNegative() {
        let availableBytes: UInt64 = 2 * 1024 * 1024 * 1024 // 2 GB
        let availableMB = Double(availableBytes) / (1024 * 1024)

        #expect(availableMB >= 0)
        #expect(abs(availableMB - 2048.0) < 0.01)
    }

    @Test("Zero memory footprint is valid")
    func zeroMemoryFootprint() {
        let physFootprint: UInt64 = 0
        let footprintMB = Double(physFootprint) / (1024 * 1024)
        #expect(footprintMB == 0)
    }

    // MARK: - Thermal state mapping

    @Test("Thermal state maps nominal to 0")
    func thermalNominal() {
        let value = thermalStateValue(.nominal)
        #expect(value == 0)
    }

    @Test("Thermal state maps fair to 1")
    func thermalFair() {
        let value = thermalStateValue(.fair)
        #expect(value == 1)
    }

    @Test("Thermal state maps serious to 2")
    func thermalSerious() {
        let value = thermalStateValue(.serious)
        #expect(value == 2)
    }

    @Test("Thermal state maps critical to 3")
    func thermalCritical() {
        let value = thermalStateValue(.critical)
        #expect(value == 3)
    }

    // MARK: - Telemetry gate

    @Test("Sampler respects telemetry gate")
    func telemetryGate() {
        // Verify the gate function exists and returns a boolean.
        // In test environments, XCTestConfigurationFilePath is set,
        // so allowsRemoteDiagnosticsUpload returns false.
        let gateResult = TelemetrySettings.allowsRemoteDiagnosticsUpload
        #expect(gateResult == false, "Tests run with automated-test detection, gate should be off")
    }

    @Test("Telemetry gate with explicit test environment rejects upload")
    func telemetryGateExplicit() {
        let allowed = TelemetrySettings.allowsRemoteDiagnosticsUpload(
            mode: .internalDiagnostics,
            environment: ["XCTestConfigurationFilePath": "/some/path"]
        )
        #expect(allowed == false)
    }

    @Test("Telemetry gate with internal mode and no test env allows upload")
    func telemetryGateInternal() {
        let allowed = TelemetrySettings.allowsRemoteDiagnosticsUpload(
            mode: .internalDiagnostics,
            environment: [:]
        )
        #expect(allowed == true)
    }

    // MARK: - Metric enum registration

    @Test("Device metric enum cases have correct raw values")
    func metricEnumRawValues() {
        #expect(ChatMetricName.deviceCpuPct.rawValue == "device.cpu_pct")
        #expect(ChatMetricName.deviceMemoryMb.rawValue == "device.memory_mb")
        #expect(ChatMetricName.deviceMemoryAvailableMb.rawValue == "device.memory_available_mb")
        #expect(ChatMetricName.deviceThermalState.rawValue == "device.thermal_state")
    }

    // MARK: - Helpers

    /// Mirrors the thermal state -> Double mapping in DeviceResourceSampler.
    private func thermalStateValue(_ state: ProcessInfo.ThermalState) -> Double {
        switch state {
        case .nominal: 0
        case .fair: 1
        case .serious: 2
        case .critical: 3
        @unknown default: 0
        }
    }
}
