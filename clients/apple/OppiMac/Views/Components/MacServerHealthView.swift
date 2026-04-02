import SwiftUI

/// Server health section showing memory usage, uptime, and active session count.
///
/// Matches the iOS `ServerHealthSection` feature set with Mac-appropriate styling.
struct MacServerHealthView: View {

    let memory: StatsMemory
    let serverInfo: ServerHealthMonitor.ServerInfo?
    let activeSessionCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Server")
                .font(.caption)
                .foregroundStyle(.secondary)

            memoryBar

            if let uptime = serverInfo?.uptime {
                infoRow(label: "Uptime", value: uptime)
            }
            if let version = serverInfo?.version, version != "unknown" {
                infoRow(label: "Version", value: version)
            }
            infoRow(label: "Active Sessions", value: "\(activeSessionCount)")
        }
    }

    // MARK: - Memory bar

    private var heapUsedMB: Int { Int(memory.heapUsed.rounded()) }
    private var heapTotalMB: Int { Int(memory.heapTotal.rounded()) }
    private var rssMB: Int { Int(memory.rss.rounded()) }

    /// RSS is the real process memory footprint. Thresholds:
    /// green < 256 MB, orange < 512 MB, red >= 512 MB.
    private var rssBarColor: Color {
        if memory.rss >= 512 { return .red }
        if memory.rss >= 256 { return .orange }
        return .green
    }

    /// Bar fill as fraction of 1 GB ceiling for visual scaling.
    private var rssFraction: Double {
        min(memory.rss / 1024, 1.0)
    }

    private var memoryBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("RSS: \(rssMB) MB")
                .font(.caption2.monospacedDigit())

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.15))
                        .frame(height: 4)
                    Capsule()
                        .fill(rssBarColor)
                        .frame(width: geo.size.width * rssFraction, height: 4)
                }
            }
            .frame(height: 4)

            Text("Heap: \(heapUsedMB) MB / \(heapTotalMB) MB")
                .font(.system(size: 9).monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Info row

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption2.monospacedDigit())
        }
    }
}
