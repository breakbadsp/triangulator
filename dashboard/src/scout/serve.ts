// tri-scout serve: the MCP server on stdio. It reads the [scout] switch at
// start and before each tool call, and sends only GET requests, one at a
// time, to endpoints that the dashboard already reads.
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { readScoutConfig } from "./config";
import { getIncident, listIncidents } from "./incident-tools";
import { handle, parseError, type Tool } from "./mcp";
import { LIMITS, listTargets, parseFleet, statusNow, ToolError } from "./tools";

/** The exit status when the switch is off. */
export const DISABLED = 2;
const VERSION = "0.1.0";
const TIMEOUT_MS = 10_000;

export interface ServeOptions {
  configPath: string;
  input: Readable;
  output: Writable;
  log: (line: string) => void;
}

/** Serves until the input ends. Returns the exit status. */
export async function serve(options: ServeOptions): Promise<number> {
  const { configPath, input, output, log } = options;
  const disabled = (reason: string) =>
    `tri-scout is disabled (${reason}). Set [scout] enabled = true in ${configPath} to use it.`;
  const config = readScoutConfig(configPath);
  if (config.kind === "off") {
    log(disabled(config.reason));
    return DISABLED;
  }
  let collectorUrl = config.collectorUrl;
  const tools = scoutTools(() => collectorUrl);
  // One message at a time: a tool call finishes before the next message
  // starts, so tri-scout never has more than one request open at the
  // collector.
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(output, parseError());
      continue;
    }
    if (isObject(message) && message.method === "tools/call") {
      // An edit of the switch to false ends the session at the next call.
      const current = readScoutConfig(configPath);
      if (current.kind === "off") {
        const reason = disabled(current.reason);
        write(output, {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: { content: [{ type: "text", text: reason }], isError: true },
        });
        log(reason);
        return DISABLED;
      }
      collectorUrl = current.collectorUrl;
    }
    const reply = await handle(message, tools, VERSION);
    if (reply) write(output, reply);
  }
  return 0;
}

function scoutTools(collectorUrl: () => string): Tool[] {
  const storePath = join(
    process.env.TRIANGULATOR_HOME ?? join(homedir(), "triangulator"),
    "data/scout/incidents.sqlite3",
  );
  const fleet = async () => {
    const base = collectorUrl();
    return parseFleet(await getJson(`${base}/api/fleet`));
  };
  const now = () => Date.now() / 1000;
  return [
    {
      name: "list_targets",
      description:
        "List the processes that Triangulator monitors, with the key to " +
        "pass to other tools, the host, PID, command, and data completeness.",
      inputSchema: { type: "object", properties: {} },
      run: async () => listTargets(await fleet(), now()),
    },
    {
      name: "status_now",
      description:
        "Is something wrong now? Gives each target's verdict (critical, " +
        "serious, warning, info, good, or unknown) and its findings, worst " +
        "first: the same assessment as the dashboard Targets page. Each " +
        `target has at most ${String(LIMITS.findings)} findings and a data object that ` +
        "states data completeness.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "A target key or ID from list_targets. Omit it for all targets.",
          },
        },
      },
      run: async (args) => {
        const target = args.target;
        if (target !== undefined && typeof target !== "string")
          throw new ToolError("target must be a string.");
        return statusNow(await fleet(), now(), target);
      },
    },
    {
      name: "list_incidents",
      description:
        "Was there an issue in a given time window? List overlapping incidents, newest first, with target, kind, severity, summary, ID, and data completeness. At most 20 incidents and 16 KiB; omitted_incidents states the remainder. Open means active at the last scan. An empty result does not prove complete coverage.",
      inputSchema: {
        type: "object",
        required: ["window"],
        properties: {
          target: {
            type: "string",
            description:
              "Exact target key, or legacy for unmapped recordings. Omit for all targets.",
          },
          window: {
            type: "object",
            required: ["start", "end"],
            properties: {
              start: {
                type: "number",
                minimum: 0,
                description: "Inclusive Unix seconds.",
              },
              end: {
                type: "number",
                description: "Exclusive Unix seconds, greater than start.",
              },
            },
          },
        },
      },
      run: (args) => Promise.resolve(listIncidents(storePath, args)),
    },
    {
      name: "get_incident",
      description:
        "Read one stored incident: observation timeline, stored rule evidence, identified contributing threads, and data completeness. The store has no per-sample timeline or contributor ranking. At most 16 KiB; omitted_fields states removed evidence.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "The exact incident ID from list_incidents.",
          },
        },
      },
      run: (args) => Promise.resolve(getIncident(storePath, args)),
    },
  ];
}

// GET only: this is the one function that sends requests to the collector.
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    throw new ToolError(
      `The collector answered ${String(response.status)} for ${new URL(url).pathname}.`,
    );
  return response.json();
}

const write = (output: Writable, reply: object) =>
  output.write(JSON.stringify(reply) + "\n");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
