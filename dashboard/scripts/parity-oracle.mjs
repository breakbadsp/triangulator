// Normal checks read only the pinned fixture. Source verification is explicit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import ts from "typescript";

const commit = "777cf3aef84376dc517086e05a7dc7c4ca1539d7";
const gitBlob = "068cb597ecc755daebf778f82b136313fb6107f6";
const path = "collector/dashboard.html";
const fixture = new URL("./oracle/dashboard-777cf3a.js.txt", import.meta.url);
const provenance = new URL("./oracle/dashboard-777cf3a.json", import.meta.url);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parse = (text) =>
  ts.createSourceFile("oracle.js", text, ts.ScriptTarget.Latest, true);
const declarationNames = `
  SETTLE_SECS settling targetExited inspectTime returnLive
  BUFFER_SECS AVG_STEP loadBuffer saveBuffer ingest loadOf updateLoadAverage
  averageCpu mapView idleFor
  STATES labels isNum pct compact number bytes perSec clock date duration ago family
  isIdle idleSecs futexShare STUCK_FUTEX_S lockHints SATURATED_PCT watchOverdueS
  sampleIntervalMs isWatched quietFor quietText isOverdue isBusyWatched watchedThreads
  watchRuleFor watchRulesOutdated andMore stuckFinding busyFinding unmatchedRules watchFindings
  threadLabel threadGrowth KERNEL_SHARE_MIN SPIN_SWITCHES_MIN kernelShare LEVEL_ORDER
  LEVEL_ICONS VERDICTS ofType assess PRESSURE_SERIES hasCgroup scopeOf stall socketName
  MOVES_DATA movesData peerWindowZero assessResources asResourcePoints resourcePoints
  memoryBytes memoryLayoutFor memoryComm isLibrary baseName memoryRegions MEMORY_GAP
  MEMORY_ROWS memoryRows memorySlope RSS_TREND_WINDOWS RSS_TREND_MIN_SPAN
  RSS_TREND_MIN_POINTS rssTrend signed assessMemory memoryOverviewFindings memoryFaultRate
  memoryPressure endedTarget EXIT_REASONS CRASH_SIGNALS KILL_SIGNALS signalLabel
  exitReason exitStatusText viewTargetName fleetName
  KIND_LABELS NET_COUNTERS DROP_COLUMNS socketLabel socketNotes renderResourceTiles socketValue socketTitles renderSocket renderSocketChart
  fillLevel fillCell renderResourceSockets renderNetstack
  meter microseconds MEMORY_KINDS MEMORY_KIND_LABELS memoryResources memoryPageSize
  memoryLayoutComplete memoryCurrentLayout memoryZoomIdentity resetMemoryTarget
  memoryGrowth memoryRegionName memoryRowName memoryPerms memoryGrows recordMemory
  renderMemoryFindings renderMemoryTiles renderMemoryMap memoryDisplaySpan
  memoryLargestGap renderMemoryZoom memoryChart memoryBoundaryPoints
  renderMemoryCharts renderMemory refreshMemoryLayout
  findingKey historyEpisodes slotTimes
`
  .trim()
  .split(/\s+/);

function extract(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "Pinned inline script exists");
  const source = parse(script);
  const names = new Set(declarationNames);
  const help = new Set(["assesshistory", "historyfilters"]);
  const declarations = [];
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      names.delete(statement.name?.text)
    ) {
      declarations.push(statement.getText(source));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          names.delete(declaration.name.text)
        )
          declarations.push(`const ${declaration.getText(source)};`);
      }
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(source) === "helpTopic" &&
      help.delete(statement.expression.arguments[0]?.text)
    ) {
      declarations.push(statement.getText(source));
    }
  }
  assert.deepEqual([...names], [], "Every oracle declaration exists");
  assert.deepEqual([...help], [], "Every consumed help call exists");
  return declarations.join("\n") + "\n";
}
export function readPinnedOracle() {
  const oracle = readFileSync(fixture, "utf8");
  const identity = JSON.parse(readFileSync(provenance, "utf8"));
  assert.equal(identity.commit, commit);
  assert.equal(identity.gitBlob, gitBlob);
  assert.equal(identity.path, path);
  assert.equal(
    sha256(oracle),
    identity.fixtureSha256,
    "Pinned oracle checksum",
  );
  // Help calls are inspected, not executed with the pure declarations.
  const source = parse(oracle);
  const declarations = source.statements
    .filter((s) => !ts.isExpressionStatement(s))
    .map((s) => s.getText(source))
    .join("\n");
  return { oracle: declarations, source };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[2];
  assert.ok(
    ["--extract", "--verify-source"].includes(action),
    "Use --extract or --verify-source with pinned Git history available",
  );
  const html = execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(html)}\0`)
      .update(html)
      .digest("hex"),
    gitBlob,
    "Pinned source blob",
  );
  const oracle = extract(html);
  const identity =
    JSON.stringify(
      {
        commit,
        path,
        gitBlob,
        sourceSha256: sha256(html),
        fixtureSha256: sha256(oracle),
      },
      null,
      2,
    ) + "\n";
  if (action === "--extract") {
    writeFileSync(fixture, oracle);
    writeFileSync(provenance, identity);
  } else {
    assert.equal(readFileSync(fixture, "utf8"), oracle);
    assert.equal(readFileSync(provenance, "utf8"), identity);
  }
  process.stdout.write(
    "PASS: fixture is the exact minimal extraction of the pinned source.\n",
  );
}
