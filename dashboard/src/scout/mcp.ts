// The part of the Model Context Protocol that tri-scout needs: one JSON-RPC
// message per line on stdio, with initialize, ping, tools/list, and
// tools/call. https://modelcontextprotocol.io/specification
import { ToolError } from "./tools";

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** Returns the result text. Throws ToolError for an input it cannot use. */
  run(args: Readonly<Record<string, unknown>>): Promise<string>;
}

// The tools subset is the same in each of these versions.
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Triangulator monitors Linux processes and their threads. Call status_now " +
  "first: it gives each target's verdict and findings, worst first, as the " +
  "Triangulator dashboard shows them. Each target has a data object. State " +
  "its gaps in the answer: a target that is not live, an unreadable view, " +
  "limited access (no I/O or wait channels), a throttled sampler, packet " +
  "loss, or an old last sample.";

type Id = string | number;
type Reply =
  | { jsonrpc: "2.0"; id: Id | null; result: object }
  | {
      jsonrpc: "2.0";
      id: Id | null;
      error: { code: number; message: string };
    };

/** The reply to one message, or null for a notification. */
export async function handle(
  message: unknown,
  tools: readonly Tool[],
  version: string,
): Promise<Reply | null> {
  if (
    !isObject(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    return failure(null, -32600, "Invalid request");
  const id = message.id;
  if (id === undefined) return null;
  if (typeof id !== "string" && typeof id !== "number")
    return failure(null, -32600, "Invalid request id");
  const params = isObject(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return success(id, {
        protocolVersion:
          typeof asked === "string" && VERSIONS.includes(asked)
            ? asked
            : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "tri", version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = tools.find((item) => item.name === params.name);
      if (!tool)
        return failure(id, -32602, `Unknown tool ${String(params.name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        return success(id, text(await tool.run(args)));
      } catch (error) {
        if (error instanceof ToolError)
          return success(id, text(error.message, true));
        const cause = error instanceof Error ? error.message : String(error);
        return success(
          id,
          text(`The collector could not answer: ${cause}`, true),
        );
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`);
  }
}

export const parseError = (): Reply => failure(null, -32700, "Parse error");

const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  isError,
});

const success = (id: Id, result: object): Reply => ({
  jsonrpc: "2.0",
  id,
  result,
});

const failure = (id: Id | null, code: number, message: string): Reply => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
