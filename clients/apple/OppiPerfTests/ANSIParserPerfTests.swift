import Testing
import Foundation
import UIKit
@testable import Oppi

/// Helper to locate the test bundle for resource loading.
private final class _ANSIParserPerfBundle {}

/// Benchmark for ANSIParser.attributedString(from:).
///
/// Uses real `npm test` output (~316KB, vitest with heavy ANSI coloring)
/// as the benchmark input. Prints METRIC lines for autoresearch.
@Suite("ANSIParserPerf", .tags(.perf))
struct ANSIParserPerfTests {

    /// Load the real npm test output fixture.
    static let testInput: String = {
        let bundle = Bundle(for: _ANSIParserPerfBundle.self)
        guard let url = bundle.url(forResource: "ansi-heavy-output", withExtension: "txt"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            // Fallback: generate synthetic data if fixture missing
            return generateFallbackInput(targetBytes: 300_000)
        }
        return text
    }()

    /// Fallback generator if fixture is missing.
    private static func generateFallbackInput(targetBytes: Int) -> String {
        let patterns: [String] = [
            "\u{1B}[32m✓\u{1B}[39m src/session.test.ts \u{1B}[2m(12 tests)\u{1B}[22m \u{1B}[33m142ms\u{1B}[39m",
            "\u{1B}[90mstdout\u{1B}[2m | tests/gondolin.test.ts\u{1B}[2m > \u{1B}[22m\u{1B}[2mGondolinManager\u{1B}[22m\u{1B}[39m",
            "[gondolin] starting VM { workspaceId: \u{1B}[32m'w1'\u{1B}[39m, cwd: \u{1B}[32m'/home/user/project'\u{1B}[39m }",
            "\u{1B}[1m\u{1B}[46m RUN \u{1B}[49m\u{1B}[22m \u{1B}[36mv4.0.18 \u{1B}[39m\u{1B}[90m/workspace/server\u{1B}[39m",
            "\u{1B}[38;5;59m─\u{1B}[39m\u{1B}[38;5;59m─\u{1B}[39m \u{1B}[38;5;179m⠋\u{1B}[39m \u{1B}[38;5;60mWorking...\u{1B}[39m",
        ]
        var result = ""
        result.reserveCapacity(targetBytes + 1024)
        var idx = 0
        while result.utf8.count < targetBytes {
            result.append(patterns[idx % patterns.count])
            result.append("\n")
            idx += 1
        }
        return result
    }

    @Test("benchmark attributedString parsing")
    func benchmarkAttributedString() {
        let input = Self.testInput
        let inputBytes = input.utf8.count
        let iterations = 5

        // Warmup
        for _ in 0..<2 {
            _ = ANSIParser.attributedString(from: input)
        }

        // Timed runs
        var durationsMs: [Double] = []
        for _ in 0..<iterations {
            let start = CFAbsoluteTimeGetCurrent()
            _ = ANSIParser.attributedString(from: input)
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
            durationsMs.append(elapsed)
        }

        durationsMs.sort()
        let median = durationsMs[durationsMs.count / 2]
        let mean = durationsMs.reduce(0, +) / Double(durationsMs.count)
        let min = durationsMs.first!
        let max = durationsMs.last!
        let throughputMBs = (Double(inputBytes) / 1_000_000.0) / (median / 1000.0)

        print("METRIC parse_p50_ms=\(String(format: "%.2f", median))")
        print("METRIC parse_mean_ms=\(String(format: "%.2f", mean))")
        print("METRIC parse_min_ms=\(String(format: "%.2f", min))")
        print("METRIC parse_max_ms=\(String(format: "%.2f", max))")
        print("METRIC input_bytes=\(inputBytes)")
        print("METRIC throughput_mbs=\(String(format: "%.2f", throughputMBs))")
    }

    @Test("benchmark strip")
    func benchmarkStrip() {
        let input = Self.testInput
        let iterations = 10

        // Warmup
        for _ in 0..<2 {
            _ = ANSIParser.strip(input)
        }

        var durationsMs: [Double] = []
        for _ in 0..<iterations {
            let start = CFAbsoluteTimeGetCurrent()
            _ = ANSIParser.strip(input)
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
            durationsMs.append(elapsed)
        }

        durationsMs.sort()
        let median = durationsMs[durationsMs.count / 2]
        print("METRIC strip_p50_ms=\(String(format: "%.2f", median))")
    }

    // MARK: - Streaming Scenario: Full Strip vs Incremental

    @Test("benchmark streaming strip O(n^2) vs incremental O(n)")
    func benchmarkStreamingStripComparison() {
        // Simulate streaming: 100 chunks, each adding ~3KB of ANSI output.
        // Total: ~300KB. Full strip on each chunk = O(n^2). Incremental = O(n).
        let chunkCount = 100
        var chunks: [String] = []
        var accumulated = ""
        for i in 0..<chunkCount {
            let line = "\u{1B}[32m\u{2713}\u{1B}[39m test_suite_\(i) "
                + "\u{1B}[2m(\(i * 7 + 42)ms)\u{1B}[22m "
                + "\u{1B}[90msrc/module/file_\(i).test.ts\u{1B}[39m\n"
                + "  \u{1B}[32m\u{2713}\u{1B}[39m should handle case \(i)\n"
                + "  \u{1B}[32m\u{2713}\u{1B}[39m should validate input \(i)\n"
            accumulated += line
            chunks.append(accumulated)
        }

        let inputBytes = accumulated.utf8.count

        // Measure: full strip on each chunk (O(n^2) total)
        let fullStripStart = CFAbsoluteTimeGetCurrent()
        var fullStripResult = ""
        for chunk in chunks {
            fullStripResult = ANSIParser.strip(chunk)
        }
        let fullStripMs = (CFAbsoluteTimeGetCurrent() - fullStripStart) * 1000.0

        // Measure: incremental strip (O(n) total)
        let incrementalStart = CFAbsoluteTimeGetCurrent()
        var stripper = ANSIParser.IncrementalStripper()
        var incrementalResult = ""
        for chunk in chunks {
            if let delta = stripper.delta(chunk) {
                incrementalResult += delta
            }
        }
        let incrementalMs = (CFAbsoluteTimeGetCurrent() - incrementalStart) * 1000.0

        // Verify correctness: both produce the same result.
        #expect(incrementalResult == fullStripResult,
            "Incremental stripper must produce identical output to full strip")

        let speedup = fullStripMs / max(0.001, incrementalMs)

        print("METRIC streaming_full_strip_ms=\(String(format: "%.2f", fullStripMs))")
        print("METRIC streaming_incremental_ms=\(String(format: "%.2f", incrementalMs))")
        print("METRIC streaming_speedup_x=\(String(format: "%.1f", speedup))")
        print("METRIC streaming_total_bytes=\(inputBytes)")
        print("METRIC streaming_chunk_count=\(chunkCount)")

        // The incremental approach should be significantly faster.
        // Full strip: ~O(n^2/2) total bytes processed.
        // Incremental: ~O(n) total bytes processed.
        #expect(speedup > 2.0,
            "Incremental strip should be at least 2x faster than full strip for 100 chunks")
    }

    @Test("benchmark stripPrefix bounded performance")
    func benchmarkStripPrefix() {
        let input = Self.testInput
        let iterations = 100

        // stripPrefix(512 bytes) should be constant-time regardless of input size.
        var durationsMs: [Double] = []
        for _ in 0..<iterations {
            let start = CFAbsoluteTimeGetCurrent()
            _ = ANSIParser.stripPrefix(input, maxInputBytes: 512)
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
            durationsMs.append(elapsed)
        }

        durationsMs.sort()
        let median = durationsMs[durationsMs.count / 2]
        print("METRIC stripPrefix_p50_ms=\(String(format: "%.4f", median))")

        // Should be sub-millisecond for any input size.
        #expect(median < 1.0,
            "stripPrefix(512 bytes) should be sub-millisecond; got \(String(format: "%.2f", median))ms")
    }
}

// MARK: - IncrementalStripper Correctness Under Stress

@Suite("ANSIParser IncrementalStripper stress", .tags(.perf))
struct IncrementalStripperStressTests {

    @Test("1000 chunks of mixed ANSI content match full strip")
    func stressMatchesFullStrip() {
        let patterns: [String] = [
            "\u{1B}[32m\u{2713}\u{1B}[39m passed\n",
            "\u{1B}[31m\u{2717}\u{1B}[39m FAILED\n",
            "\u{1B}[1m\u{1B}[46m RUN \u{1B}[49m\u{1B}[22m test\n",
            "\u{1B}[38;5;196mred-256\u{1B}[39m\n",
            "\u{1B}[38;2;128;200;50mrgb-color\u{1B}[0m\n",
            "plain text line\n",
            "\u{1B}[2mdim output\u{1B}[22m\n",
        ]

        var full = ""
        var stripper = ANSIParser.IncrementalStripper()
        var accumulated = ""

        for i in 0..<1000 {
            full += patterns[i % patterns.count]
            if let delta = stripper.delta(full) {
                accumulated += delta
            }
        }

        #expect(accumulated == ANSIParser.strip(full))
    }
}
