// tri-scout: optional read-only tools for an LLM client (REQ-0001).
// Build with `make scout`; run with `node build/tri-scout.mjs serve`.
import { defaultConfigPath } from "./config";
import { serve } from "./serve";

const USAGE = "usage: tri-scout serve [--config <collector.toml>]";

async function main(args: readonly string[]): Promise<number> {
  const [mode, ...rest] = args;
  const configPath =
    rest[0] === "--config" && rest.length === 2 && rest[1]
      ? rest[1]
      : rest.length === 0
        ? defaultConfigPath(process.env)
        : null;
  if (mode !== "serve" || configPath === null) {
    process.stderr.write(USAGE + "\n");
    return 1;
  }
  const status = await serve({
    configPath,
    input: process.stdin,
    output: process.stdout,
    log: (line) => process.stderr.write(line + "\n"),
  });
  // Release stdin, so a session that the switch ended exits even when the
  // client keeps the pipe open.
  process.stdin.destroy();
  return status;
}

process.exitCode = await main(process.argv.slice(2));
