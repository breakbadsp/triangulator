import { readPage } from "../page";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The parsed JSON error reply, when it was JSON. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiPath(path: string): string {
  const page = readPage();
  if (
    page.kind === "target" &&
    page.key &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/targets")
  ) {
    return `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ target: page.key })}`;
  }
  return path;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText || `HTTP ${String(response.status)}`;
    let body: unknown;
    try {
      body = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        message = body.error;
      }
    } catch {
      // HTTP errors must retain their status even when the body is not JSON.
    }
    throw new ApiError(response.status, message, body);
  }
  // The same collector binary owns the JSON writers and this embedded page.
  return (await response.json()) as T;
}

export async function getJson<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  return readJson<T>(await fetch(apiPath(path), { signal }));
}

export async function postJson<T>(
  path: string,
  body: unknown,
  { ifMatch }: { ifMatch?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Triangulator": "1",
  };
  if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
  return readJson<T>(
    await fetch(apiPath(path), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}
