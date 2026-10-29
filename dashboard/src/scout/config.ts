import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

/**
 * The [scout] switch and the collector address, from collector.toml. Any
 * file that cannot turn the switch on gives "off", so tri-scout fails closed.
 */
export type ScoutConfig =
  | { kind: "off"; reason: string }
  | {
      kind: "on";
      collectorUrl: string;
      dataDir: string;
      retentionDays: number;
    };

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.TRIANGULATOR_HOME ?? join(homedir(), "triangulator");
  return join(home, "config", "collector.toml");
}

export function readScoutConfig(path: string): ScoutConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return off(`cannot read ${path}: ${message(error)}`);
  }
  return parseScoutConfig(text);
}

export function parseScoutConfig(text: string): ScoutConfig {
  let root: Record<string, unknown>;
  try {
    root = parse(text);
  } catch (error) {
    return off(`collector.toml is not valid TOML: ${message(error)}`);
  }
  const scout = root.scout;
  if (scout === undefined) return off("collector.toml has no [scout] table");
  if (!isTable(scout) || typeof scout.enabled !== "boolean")
    return off("[scout] enabled must be true or false");
  if (!scout.enabled) return off("[scout] enabled = false");
  const host = root.http_host ?? "127.0.0.1";
  const port = root.http_port ?? 9401;
  if (typeof host !== "string" || host === "")
    return off("http_host must be a host name or address");
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)
    return off("http_port must be 1..65535");
  const retentionDays = scout.retention_days ?? 90;
  if (
    typeof retentionDays !== "number" ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1
  )
    return off("[scout] retention_days must be a positive integer");
  const dataDir = root.data_dir ?? "./data";
  if (typeof dataDir !== "string" || !dataDir)
    return off("data_dir must be a path");
  return {
    kind: "on",
    collectorUrl: url(host, Number(port)),
    dataDir,
    retentionDays,
  };
}

// A collector that listens on every address also answers on loopback.
function url(host: string, port: number) {
  const target =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const name = target.includes(":") ? `[${target}]` : target;
  return `http://${name}:${String(port)}`;
}

const off = (reason: string): ScoutConfig => ({ kind: "off", reason });

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
