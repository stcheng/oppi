# Testing Guide

Canonical test commands for the Oppi monorepo.

## Server

From `server/`:

```bash
npm run check
npm test
```

For faster PR gates:

```bash
npm run test:gate:pr-fast
```

## Apple

From `clients/apple/`:

### Regenerate project

```bash
xcodegen generate
```

### Simulator build

Always use `sim-pool.sh` for simulator builds and tests.

```bash
bash ~/.pi/agent/skills/oppi-dev/scripts/sim-pool.sh \
  run -- xcodebuild -project Oppi.xcodeproj -scheme Oppi build
```

### iOS unit tests

Use the dedicated `OppiUnitTests` scheme for `OppiTests`.

```bash
bash ~/.pi/agent/skills/oppi-dev/scripts/sim-pool.sh \
  run -- xcodebuild -project Oppi.xcodeproj -scheme OppiUnitTests test \
  -only-testing:OppiTests
```

Why: the full `Oppi` scheme also builds `OppiPerfTests`, `OppiUITests`, and `OppiE2ETests`, which makes focused unit-test runs look hung.

### Swift Testing filters

`xcodebuild` strips one trailing `()` from Swift Testing identifiers.
Use double parentheses for function-level filters.

Examples:

```bash
# Suite
bash ~/.pi/agent/skills/oppi-dev/scripts/sim-pool.sh \
  run -- xcodebuild -project Oppi.xcodeproj -scheme OppiUnitTests test \
  -only-testing:OppiTests/MySuiteStruct

# Function
bash ~/.pi/agent/skills/oppi-dev/scripts/sim-pool.sh \
  run -- xcodebuild -project Oppi.xcodeproj -scheme OppiUnitTests test \
  -only-testing:'OppiTests/MySuiteStruct/myTestFunc()()'
```

### UI / E2E / perf tests

These still use the full `Oppi` scheme or their dedicated scripts, because they intentionally exercise non-unit-test bundles.

```bash
# E2E lane
bash ~/.pi/agent/skills/oppi-dev/scripts/oppi-workflow.sh sim-test
```

### Coverage

```bash
bash ~/.pi/agent/skills/oppi-dev/scripts/apple/check-coverage.sh
```

### Protocol checks

```bash
bash ~/.pi/agent/skills/oppi-dev/scripts/check-protocol.sh
```

## Failure investigation

`sim-pool.sh` writes full output to a log file and prints the log path in its summary.
Read the log file directly instead of rerunning the same build blindly.

Do not pipe `sim-pool.sh` through `grep`, `tail`, or `head`.
