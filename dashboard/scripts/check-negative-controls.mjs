// Deliberate faults run in memory or child processes. Source files stay intact.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import ts from "typescript";

const dashboard = fileURLToPath(new URL("../", import.meta.url));
for (const flag of ["--negative-average-step", "--negative-pid-filter"]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-pure-parity.mjs", flag],
    { cwd: dashboard, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${flag} must fail`);
  assert.match(result.stderr, /AssertionError/);
  if (flag === "--negative-pid-filter")
    assert.match(
      result.stderr,
      /Unavailable RSS PID boundary must end the run/,
    );
  process.stdout.write(
    `PASS: ${flag} is rejected by the behavior comparison.\n`,
  );
}
const filename = resolve(dashboard, "src/help/topics.ts");
const source = readFileSync(filename, "utf8");
const altered = source.replace(
  'related: ["cpu", "pressure", "health"]',
  'related: ["__invalid_topic__", "pressure", "health"]',
);
assert.notEqual(
  altered,
  source,
  "The related-topic control must change the input",
);
const config = ts.readConfigFile(
  resolve(dashboard, "tsconfig.json"),
  ts.sys.readFile,
);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dashboard);
const host = ts.createCompilerHost(parsed.options);
const original = host.getSourceFile;
host.getSourceFile = (path, languageVersion, ...args) =>
  resolve(path) === filename
    ? ts.createSourceFile(path, altered, languageVersion, true)
    : original(path, languageVersion, ...args);
const program = ts.createProgram(parsed.fileNames, parsed.options, host);
const diagnostic = ts
  .getPreEmitDiagnostics(program)
  .find(
    (d) =>
      d.code === 2322 &&
      ts
        .flattenDiagnosticMessageText(d.messageText, "\n")
        .includes("__invalid_topic__"),
  );
assert.ok(diagnostic, "TypeScript must reject an undefined related ID");
process.stdout.write(
  "PASS: TypeScript rejects __invalid_topic__ in the actual registry (TS2322).\n",
);
