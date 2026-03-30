import Testing

extension Tag {
    /// Performance and benchmark tests — excluded from fast feedback loops.
    @Tag static var perf: Self
    /// Tests that generate artifacts for visual inspection.
    @Tag static var artifact: Self
}
