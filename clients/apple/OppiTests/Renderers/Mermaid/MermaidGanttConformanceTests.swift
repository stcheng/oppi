import Testing
@testable import Oppi

// SPEC: https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/syntax/gantt.md
//
// Tests for gantt features not yet covered.
//
// COVERAGE (new):
// [ ] tickInterval directive
// [ ] weekend directive (with excludes weekends)
// [ ] Vertical markers: vert status
// [ ] Comments in gantt charts (%%)
// [ ] Multiple excludes values
// [ ] excludes weekends keyword

@Suite("Gantt Conformance — Missing Features")
struct MermaidGanttConformanceTests {
    let parser = MermaidParser()

    // MARK: - tickInterval

    /// SPEC: ### Axis ticks — `tickInterval 1day`
    @Test func tickIntervalDirective() {
        let result = parser.parse("""
        gantt
            dateFormat YYYY-MM-DD
            tickInterval 1day
            section Tasks
                Task A :2024-01-01, 3d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.tickInterval == "1day")
        // tickInterval should not be parsed as a task.
        #expect(d.sections.first?.tasks.count == 1)
    }

    /// tickInterval with week unit
    @Test func tickIntervalWeek() {
        let result = parser.parse("""
        gantt
            dateFormat YYYY-MM-DD
            tickInterval 1week
            section Tasks
                Task A :2024-01-01, 7d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.tickInterval == "1week")
    }

    // MARK: - Weekend

    /// SPEC: #### Weekend — `weekend friday` with `excludes weekends`
    @Test func weekendDirective() {
        let result = parser.parse("""
        gantt
            dateFormat YYYY-MM-DD
            excludes weekends
            weekend friday
            section Section
                A task :a1, 2024-01-01, 30d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.excludes.contains("weekends"))
        #expect(d.weekend == "friday")
        // "weekend" should not be parsed as a task.
        #expect(d.sections.first?.tasks.count == 1)
    }

    // MARK: - Vertical markers

    /// SPEC: ### Vertical Markers — `vert` status keyword
    @Test func verticalMarker() {
        let result = parser.parse("""
        gantt
            dateFormat HH:mm
            axisFormat %H:%M
            Initial vert : vert, v1, 17:30, 2m
            Task A : 3m
            Task B : 8m
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        // The vert marker should be parsed as a task with vert status.
        let vertTask = d.sections.flatMap(\.tasks).first { $0.status == .vert }
        #expect(vertTask != nil, "Should have a task with vert status")
        #expect(vertTask?.name == "Initial vert")
    }

    // MARK: - Comments

    /// SPEC: ## Comments — `%% comment`
    @Test func commentsInGantt() {
        let result = parser.parse("""
        gantt
            dateFormat YYYY-MM-DD
            %% This is a comment
            section Tasks
                %% Another comment
                Task A :2024-01-01, 3d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.sections.first?.tasks.count == 1)
        #expect(d.sections.first?.tasks.first?.name == "Task A")
    }

    // MARK: - Excludes

    /// Multiple excludes values including specific dates and weekends
    @Test func multipleExcludes() {
        let result = parser.parse("""
        gantt
            dateFormat YYYY-MM-DD
            excludes weekends
            excludes 2024-01-15, 2024-02-14
            section Tasks
                Task A :2024-01-01, 30d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.excludes.contains("weekends"))
        #expect(d.excludes.contains("2024-01-15"))
        #expect(d.excludes.contains("2024-02-14"))
    }

    // MARK: - Combined spec example

    /// Full spec example with multiple features.
    @Test func fullGanttExample() {
        let result = parser.parse("""
        gantt
            title A Gantt Diagram
            dateFormat YYYY-MM-DD
            axisFormat %Y-%m-%d
            tickInterval 1week
            excludes weekends
            section Design
                Research           :done, des1, 2024-01-01, 2024-01-05
                Prototyping        :active, des2, after des1, 5d
            section Implementation
                Coding             :crit, impl1, 2024-01-10, 10d
                Testing            :after impl1, 5d
                Deploy             :milestone, after impl1, 0d
        """)
        guard case .gantt(let d) = result else {
            Issue.record("Expected gantt")
            return
        }
        #expect(d.title == "A Gantt Diagram")
        #expect(d.tickInterval == "1week")
        #expect(d.sections.count == 2)
        #expect(d.sections[0].tasks.count == 2)
        #expect(d.sections[1].tasks.count == 3)
    }
}
