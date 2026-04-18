#!/usr/bin/env bun
//
// testflight.ts — Archive, upload to App Store Connect, optionally submit to external beta.
//
// Usage:
//   bun scripts/testflight.ts --bump                          # bump build number, archive, upload
//   bun scripts/testflight.ts --bump --submit-external        # + submit to "Pi Discord Beta"
//   bun scripts/testflight.ts --build-number 25               # explicit build number
//   bun scripts/testflight.ts --build-only                    # archive + export IPA only (no upload)
//   bun scripts/testflight.ts list-builds                     # list recent builds from ASC
//   bun scripts/testflight.ts submit-external [build] [group] [notes-file] # manual review + promote
//   bun scripts/testflight.ts show-what-to-test 28                           # show current What to Test text
//   bun scripts/testflight.ts set-what-to-test 28 [notes-file]               # update What to Test (default: .internal/release-notes/...)
//
// Prerequisites:
//   - Xcode with automatic signing (team AZAQMY4SPZ)
//   - ASC API key: ~/.appstoreconnect/AuthKey_<KEY_ID>.p8
//   - ASC issuer ID: ~/.appstoreconnect/issuer_id
//   - XcodeGen installed (brew install xcodegen)

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "node:readline/promises";
import { $ } from "bun";

// ── Constants ──

const BUNDLE_ID = "dev.chenda.Oppi";
const TEAM_ID = "AZAQMY4SPZ";
const DEFAULT_GROUP = "Pi Discord Beta";
const DEFAULT_WHAT_TO_TEST_LOCALE = "en-US";
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const APPLE_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(APPLE_DIR, "..", "..");
const PROJECT_YML = path.join(APPLE_DIR, "project.yml");
const DEFAULT_INTERNAL_RELEASE_NOTES_DIR = path.join(REPO_ROOT, ".internal", "release-notes");

// ── ASC credentials ──

function loadCredentials(): { keyId: string; issuerId: string; privateKey: string; keyPath: string } {
  const home = process.env.HOME!;
  const keyId = (process.env.ASC_KEY_ID || readFileOr(`${home}/.appstoreconnect/key_id`)).trim();
  const issuerId = (process.env.ASC_ISSUER_ID || readFileOr(`${home}/.appstoreconnect/issuer_id`)).trim();
  const keyPath = process.env.ASC_KEY_PATH || `${home}/.appstoreconnect/AuthKey_${keyId}.p8`;
  const privateKey = fs.readFileSync(keyPath, "utf-8");
  return { keyId, issuerId, privateKey, keyPath };
}

function readFileOr(filePath: string, fallback = ""): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

// ── ASC API ──

let _creds: ReturnType<typeof loadCredentials> | null = null;
function creds() {
  if (!_creds) _creds = loadCredentials();
  return _creds;
}

function makeJWT(): string {
  const { keyId, issuerId, privateKey } = creds();
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }),
  ).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

async function ascApi(urlPath: string, method = "GET", body?: object): Promise<any> {
  const jwt = makeJWT();
  const opts: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.appstoreconnect.apple.com${urlPath}`, opts);
  if (method === "DELETE" && res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(`ASC API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ── ASC helpers ──

async function findApp(): Promise<string> {
  const resp = await ascApi(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = resp.data?.[0];
  if (!app) throw new Error(`App not found for bundle ID: ${BUNDLE_ID}`);
  return app.id;
}

async function listBuilds(appId: string, limit = 10): Promise<any[]> {
  const resp = await ascApi(
    `/v1/builds?filter[app]=${appId}&sort=-version&limit=${limit}&fields[builds]=version,processingState,uploadedDate,minOsVersion`,
  );
  return resp.data || [];
}

async function findBuild(appId: string, buildNumber: string): Promise<any | null> {
  const resp = await ascApi(`/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}`);
  return resp.data?.[0] || null;
}

async function waitForBuild(appId: string, buildNumber: string, maxWait = 900): Promise<any> {
  const start = Date.now();
  const interval = 30_000;
  console.log(`Waiting for build ${buildNumber} to finish processing (up to ${maxWait / 60} min)...`);

  while (Date.now() - start < maxWait * 1000) {
    const build = await findBuild(appId, buildNumber);
    if (!build) {
      console.log(`  Build ${buildNumber} not yet visible in ASC, retrying...`);
      await sleep(interval);
      continue;
    }
    const state = build.attributes.processingState;
    console.log(`  Build ${buildNumber}: ${state}`);
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(`Build ${buildNumber} processing failed: ${state}`);
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for build ${buildNumber} to process`);
}

async function findBetaGroup(appId: string, groupName: string): Promise<string> {
  const resp = await ascApi(`/v1/apps/${appId}/betaGroups`);
  const group = (resp.data || []).find((g: any) => g.attributes.name === groupName);
  if (!group) {
    const available = (resp.data || []).map((g: any) => g.attributes.name).join(", ");
    throw new Error(`Beta group "${groupName}" not found. Available: ${available}`);
  }
  return group.id;
}

async function addBuildToGroup(groupId: string, buildId: string): Promise<void> {
  await ascApi(`/v1/betaGroups/${groupId}/relationships/builds`, "POST", {
    data: [{ type: "builds", id: buildId }],
  });
  console.log(`Build added to beta group.`);
}

async function buildBetaDetail(buildId: string): Promise<any | null> {
  const resp = await ascApi(`/v1/builds/${buildId}/buildBetaDetail`);
  return resp.data || null;
}

async function submitForBetaReview(buildId: string): Promise<void> {
  try {
    await ascApi(`/v1/betaAppReviewSubmissions`, "POST", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: buildId } } } },
    });
    console.log(`Build submitted for beta app review.`);
    return;
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (!msg.includes("INVALID_QC_STATE")) throw err;

    let externalState = "UNKNOWN";
    try {
      const detail = await buildBetaDetail(buildId);
      externalState = detail?.attributes?.externalBuildState || "UNKNOWN";
    } catch {
      // best-effort lookup
    }

    console.log(
      `Build is already in an external beta state (${externalState}); skipping beta review submission.`,
    );
  }
}

async function listBetaBuildLocalizations(buildId: string): Promise<any[]> {
  const resp = await ascApi(`/v1/builds/${buildId}/betaBuildLocalizations?limit=200`);
  return resp.data || [];
}

async function upsertWhatToTest(buildId: string, whatsNew: string, locale: string): Promise<void> {
  const localizations = await listBetaBuildLocalizations(buildId);
  const existing = localizations.find((loc: any) => loc.attributes?.locale === locale);

  if (existing) {
    await ascApi(`/v1/betaBuildLocalizations/${existing.id}`, "PATCH", {
      data: {
        type: "betaBuildLocalizations",
        id: existing.id,
        attributes: { whatsNew },
      },
    });
    console.log(`Updated What to Test (${locale}).`);
    return;
  }

  await ascApi(`/v1/betaBuildLocalizations`, "POST", {
    data: {
      type: "betaBuildLocalizations",
      attributes: { locale, whatsNew },
      relationships: {
        build: {
          data: { type: "builds", id: buildId },
        },
      },
    },
  });

  console.log(`Created What to Test (${locale}).`);
}

function defaultWhatToTestPath(buildNumber: string): string {
  return path.join(DEFAULT_INTERNAL_RELEASE_NOTES_DIR, `testflight-build-${buildNumber}-what-to-test.md`);
}

function resolveWhatToTestPath(buildNumber: string, filePath?: string): string {
  if (filePath) return path.resolve(process.cwd(), filePath);
  return defaultWhatToTestPath(buildNumber);
}

function loadWhatToTestText(buildNumber: string, filePath?: string): { absPath: string; whatsNew: string } {
  const absPath = resolveWhatToTestPath(buildNumber, filePath);
  if (!fs.existsSync(absPath)) {
    die(`What to Test file not found: ${absPath}\nCreate it (default path: ${defaultWhatToTestPath(buildNumber)}) and re-run.`);
  }

  const whatsNew = fs.readFileSync(absPath, "utf-8").trim();
  if (!whatsNew) {
    die(`What to Test content is empty: ${absPath}`);
  }

  return { absPath, whatsNew };
}

async function confirmManualReleaseNoteReview(buildNumber: string, absPath: string, whatsNew: string): Promise<void> {
  console.log(`--- Manual release-note review required (build ${buildNumber}) ---`);
  console.log(`File: ${absPath}`);
  console.log();
  console.log(whatsNew);
  console.log();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die("Manual release-note review requires an interactive terminal.");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Type 'submit' to continue external promotion: ")).trim().toLowerCase();
    if (answer !== "submit") {
      die("Aborted before external promotion.");
    }
  } finally {
    rl.close();
  }
}

async function reviewAndSyncWhatToTest(
  build: any,
  buildNumber: string,
  filePath: string | undefined,
  locale: string,
): Promise<void> {
  const { absPath, whatsNew } = loadWhatToTestText(buildNumber, filePath);
  await confirmManualReleaseNoteReview(buildNumber, absPath, whatsNew);

  console.log(`Updating build ${buildNumber} What to Test (${locale}) from ${absPath}...`);
  await upsertWhatToTest(build.id, whatsNew, locale);
  console.log("Done.");
}

// ── Build number helpers ──

function readCurrentBuild(): number {
  const content = fs.readFileSync(PROJECT_YML, "utf-8");
  const match = content.match(/CURRENT_PROJECT_VERSION:\s*(\d+)/);
  if (!match) throw new Error("CURRENT_PROJECT_VERSION not found in project.yml");
  return parseInt(match[1], 10);
}

function updateBuildNumber(oldBuild: number, newBuild: number): void {
  let content = fs.readFileSync(PROJECT_YML, "utf-8");
  content = content.replaceAll(`CURRENT_PROJECT_VERSION: ${oldBuild}`, `CURRENT_PROJECT_VERSION: ${newBuild}`);
  fs.writeFileSync(PROJECT_YML, content, "utf-8");
}

// ── Utilities ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── Commands ──

async function cmdListBuilds(): Promise<void> {
  const appId = await findApp();
  const builds = await listBuilds(appId);

  if (builds.length === 0) {
    console.log("No builds found.");
    return;
  }

  console.log("Recent builds:");
  console.log("  BUILD    STATE              UPLOADED");
  console.log("  -----    -----              --------");
  for (const b of builds) {
    const ver = b.attributes.version.padEnd(8);
    const state = b.attributes.processingState.padEnd(18);
    const date = b.attributes.uploadedDate?.slice(0, 19) || "—";
    console.log(`  ${ver} ${state} ${date}`);
  }
}

async function cmdShowWhatToTest(
  buildNumber?: string,
  locale = DEFAULT_WHAT_TO_TEST_LOCALE,
): Promise<void> {
  const appId = await findApp();

  let build: any;
  if (buildNumber) {
    build = await findBuild(appId, buildNumber);
    if (!build) die(`Build ${buildNumber} not found in App Store Connect.`);
  } else {
    const builds = await listBuilds(appId, 1);
    if (builds.length === 0) die("No builds found in App Store Connect.");
    build = builds[0];
  }

  const localizations = await listBetaBuildLocalizations(build.id);
  if (localizations.length === 0) {
    console.log(`Build ${build.attributes.version} has no What to Test localizations yet.`);
    return;
  }

  const match = localizations.find((loc: any) => loc.attributes?.locale === locale) || localizations[0];
  const whatsNew = match.attributes?.whatsNew || "";

  console.log(`Build ${build.attributes.version} What to Test (${match.attributes?.locale || "unknown-locale"})`);
  console.log("---");
  console.log(whatsNew || "(empty)");
}

async function cmdSetWhatToTest(
  buildNumber: string,
  filePath?: string,
  locale = DEFAULT_WHAT_TO_TEST_LOCALE,
): Promise<void> {
  if (!buildNumber) die("set-what-to-test requires a build number, e.g. set-what-to-test 28 [file]");

  const { absPath, whatsNew } = loadWhatToTestText(buildNumber, filePath);
  const appId = await findApp();
  const build = await findBuild(appId, buildNumber);
  if (!build) {
    die(`Build ${buildNumber} not found in App Store Connect.`);
  }

  console.log(`Updating build ${build.attributes.version} What to Test (${locale}) from ${absPath}...`);
  await upsertWhatToTest(build.id, whatsNew, locale);
  console.log("Done.");
}

async function cmdSubmitExternal(
  buildNumber?: string,
  groupName?: string,
  whatToTestFile?: string,
  locale = DEFAULT_WHAT_TO_TEST_LOCALE,
): Promise<void> {
  const group = groupName || DEFAULT_GROUP;
  const appId = await findApp();

  let build: any;
  if (buildNumber) {
    build = await findBuild(appId, buildNumber);
    if (!build) die(`Build ${buildNumber} not found in App Store Connect.`);
    if (build.attributes.processingState !== "VALID") {
      console.log(`Build ${buildNumber} is ${build.attributes.processingState}, waiting...`);
      build = await waitForBuild(appId, buildNumber);
    }
  } else {
    // Use the latest build
    const builds = await listBuilds(appId, 1);
    if (builds.length === 0) die("No builds found in App Store Connect.");
    build = builds[0];
    if (build.attributes.processingState !== "VALID") {
      console.log(`Latest build ${build.attributes.version} is ${build.attributes.processingState}, waiting...`);
      build = await waitForBuild(appId, build.attributes.version);
    }
    console.log(`Using latest build: ${build.attributes.version}`);
  }

  const resolvedBuildNumber = String(build.attributes.version);
  await reviewAndSyncWhatToTest(build, resolvedBuildNumber, whatToTestFile, locale);

  const groupId = await findBetaGroup(appId, group);
  console.log(`Adding build ${resolvedBuildNumber} to "${group}"...`);
  await addBuildToGroup(groupId, build.id);

  console.log(`Submitting build ${resolvedBuildNumber} for beta review...`);
  await submitForBetaReview(build.id);

  console.log(`\nBuild ${resolvedBuildNumber} promoted to "${group}" for external testing.`);
}

async function cmdBuild(opts: {
  bump: boolean;
  buildOnly: boolean;
  submitExternal: boolean;
  externalGroup: string;
  explicitBuild: string;
  whatToTestFile: string;
  whatToTestLocale: string;
}): Promise<void> {
  const { bump, buildOnly, submitExternal, externalGroup, explicitBuild, whatToTestFile, whatToTestLocale } = opts;

  // Validate credentials for upload
  if (!buildOnly) {
    const { issuerId, keyPath } = creds();
    if (!issuerId) die("ASC_ISSUER_ID not set and ~/.appstoreconnect/issuer_id not found");
    if (!fs.existsSync(keyPath)) die(`API key not found at ${keyPath}`);
  }

  // Step 1: Determine build number
  const currentBuild = readCurrentBuild();
  let newBuild: number;
  if (explicitBuild) {
    newBuild = parseInt(explicitBuild, 10);
    if (isNaN(newBuild)) die(`Invalid build number: ${explicitBuild}`);
  } else if (bump) {
    newBuild = currentBuild + 1;
  } else {
    die("Specify --bump or --build-number <N>");
    return; // unreachable but satisfies TS
  }

  const buildDir = path.join(APPLE_DIR, "build", `testflight-${timestamp()}`);
  const archivePath = path.join(buildDir, "Oppi.xcarchive");
  const exportPath = path.join(buildDir, "export");

  console.log("=== Oppi TestFlight Build ===");
  console.log(`Build number: ${currentBuild} -> ${newBuild}`);
  console.log(`Build dir:    ${buildDir}`);
  console.log();

  // Step 2: Update build number in project.yml
  if (newBuild !== currentBuild) {
    console.log(`--- Step 2: Bumping build number to ${newBuild} ---`);
    updateBuildNumber(currentBuild, newBuild);
    console.log("Done.");
  } else {
    console.log(`--- Step 2: Build number unchanged (${currentBuild}) ---`);
  }

  // Step 3: Generate Xcode project
  console.log("--- Step 3: Generating Xcode project ---");
  $.cwd(APPLE_DIR);
  await $`xcodegen generate`.quiet();
  console.log("Done.");

  // Step 4: Archive
  console.log("--- Step 4: Archiving Oppi (Release, iOS device) ---");
  fs.mkdirSync(buildDir, { recursive: true });

  const archiveResult =
    await $`xcodebuild archive -project Oppi.xcodeproj -scheme Oppi -archivePath ${archivePath} -configuration Release -destination generic/platform=iOS -allowProvisioningUpdates CURRENT_PROJECT_VERSION=${newBuild} 2>&1 | tail -20`.nothrow();
  console.log(archiveResult.text());

  if (!fs.existsSync(archivePath)) {
    die(`Archive failed — ${archivePath} not found.`);
  }
  console.log("Archive created.");

  // Step 5: Export / Upload
  if (buildOnly) {
    console.log("--- Step 5: Exporting IPA (build-only, no upload) ---");
    const localPlist = path.join(buildDir, "ExportOptions-local.plist");
    fs.writeFileSync(
      localPlist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>`,
    );

    const exportResult =
      await $`xcodebuild -exportArchive -archivePath ${archivePath} -exportPath ${exportPath} -exportOptionsPlist ${localPlist} -allowProvisioningUpdates 2>&1 | tail -10`.nothrow();
    console.log(exportResult.text());
    console.log(`IPA exported to: ${exportPath}/`);
  } else {
    console.log("--- Step 5: Exporting + uploading to App Store Connect ---");
    const { keyPath, keyId, issuerId } = creds();
    const exportPlist = path.join(APPLE_DIR, "ExportOptions-AppStore.plist");

    const uploadResult =
      await $`xcodebuild -exportArchive -archivePath ${archivePath} -exportPath ${exportPath} -exportOptionsPlist ${exportPlist} -allowProvisioningUpdates -authenticationKeyPath ${keyPath} -authenticationKeyID ${keyId} -authenticationKeyIssuerID ${issuerId} 2>&1 | tail -20`.nothrow();
    console.log(uploadResult.text());

    if (uploadResult.exitCode !== 0) {
      die("Upload to App Store Connect failed.");
    }
    console.log("Upload complete.");
  }

  // Step 6: Submit for external beta (optional)
  if (submitExternal && !buildOnly) {
    console.log(`--- Step 6: Submitting to external beta group "${externalGroup}" ---`);
    const appId = await findApp();
    const build = await waitForBuild(appId, String(newBuild));

    await reviewAndSyncWhatToTest(build, String(newBuild), whatToTestFile || undefined, whatToTestLocale);

    const groupId = await findBetaGroup(appId, externalGroup);
    console.log(`Adding build ${newBuild} to "${externalGroup}"...`);
    await addBuildToGroup(groupId, build.id);

    console.log(`Submitting build ${newBuild} for beta review...`);
    await submitForBetaReview(build.id);

    console.log(`Build ${newBuild} promoted to "${externalGroup}" for external testing.`);
  }

  // Summary
  console.log();
  console.log(`=== TestFlight build ${newBuild} complete ===`);
  console.log(`Archive:  ${archivePath}`);
  if (fs.existsSync(exportPath)) {
    console.log(`Export:   ${exportPath}/`);
  }
  if (!buildOnly) {
    console.log("Status:   Uploaded to App Store Connect");
    console.log();
    console.log(`Next: check TestFlight in App Store Connect for build ${newBuild}`);
  }
}

// ── Help ──

function printHelp(): void {
  console.log(`testflight.ts — Archive, upload to App Store Connect, and promote builds to external testing.

Build commands:
  bun testflight.ts --bump                            Bump build number, archive, upload
  bun testflight.ts --bump --submit-external          Manual review notes + promote to "${DEFAULT_GROUP}"
  bun testflight.ts --bump --submit-external "Group"  Manual review notes + promote to named group
  bun testflight.ts --build-number 25                 Explicit build number
  bun testflight.ts --build-only                      Archive + export IPA only (no upload)

Standalone commands:
  bun testflight.ts list-builds                                             List recent builds from ASC
  bun testflight.ts submit-external [build] [group] [file] [locale]         Manual review + sync notes + promote build
  bun testflight.ts show-what-to-test [build] [locale]                      Show current What to Test text
  bun testflight.ts set-what-to-test <build> [file] [locale]                Update What to Test from a file

Options:
  --what-to-test-file <file>                                   Notes file (default: .internal/release-notes/testflight-build-<N>-what-to-test.md)
  --what-to-test-locale <locale>                               Locale for What to Test (default: ${DEFAULT_WHAT_TO_TEST_LOCALE})
  --help, -h                                                    Show this help`);
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // Standalone commands
  if (args[0] === "list-builds") {
    await cmdListBuilds();
    return;
  }

  if (args[0] === "submit-external") {
    await cmdSubmitExternal(args[1], args[2], args[3], args[4] || DEFAULT_WHAT_TO_TEST_LOCALE);
    return;
  }

  if (args[0] === "show-what-to-test") {
    await cmdShowWhatToTest(args[1], args[2] || DEFAULT_WHAT_TO_TEST_LOCALE);
    return;
  }

  if (args[0] === "set-what-to-test") {
    await cmdSetWhatToTest(args[1], args[2], args[3] || DEFAULT_WHAT_TO_TEST_LOCALE);
    return;
  }

  // Build flow: parse flags
  let bump = false;
  let buildOnly = false;
  let submitExternal = false;
  let externalGroup = DEFAULT_GROUP;
  let explicitBuild = "";
  let whatToTestFile = "";
  let whatToTestLocale = DEFAULT_WHAT_TO_TEST_LOCALE;

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--bump":
        bump = true;
        i++;
        break;
      case "--build-only":
        buildOnly = true;
        i++;
        break;
      case "--build-number":
        explicitBuild = args[i + 1] || die("--build-number requires a value");
        i += 2;
        break;
      case "--submit-external":
        submitExternal = true;
        if (args[i + 1] && !args[i + 1].startsWith("--")) {
          externalGroup = args[i + 1];
          i += 2;
        } else {
          i++;
        }
        break;
      case "--what-to-test-file":
        whatToTestFile = args[i + 1] || die("--what-to-test-file requires a value");
        i += 2;
        break;
      case "--what-to-test-locale":
        whatToTestLocale = args[i + 1] || die("--what-to-test-locale requires a value");
        i += 2;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  if (!bump && !explicitBuild) {
    die("Specify --bump or --build-number <N>");
  }

  await cmdBuild({
    bump,
    buildOnly,
    submitExternal,
    externalGroup,
    explicitBuild,
    whatToTestFile,
    whatToTestLocale,
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
