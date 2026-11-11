import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type CoreRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class CoreRpcError extends Error {
  readonly kind?: string;

  constructor(message: string, kind?: string) {
    super(message);
    this.kind = kind;
  }
}

// hc connect selects the same socket/session as hc run, including custom
// HC_SOCKET and HC_SESSION. Plain mode is newline-delimited JSON-RPC.
export const coreRequest: CoreRequest = (method, params) => new Promise((resolve, reject) => {
  const child = spawn("hc", ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  let settled = false;
  const finish = (error?: Error, result?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill();
    if (error) reject(error);
    else resolve(result);
  };
  const timer = setTimeout(() => finish(new Error(`hc ${method} timed out`)), 5_000);
  child.on("error", (error) => finish(error));
  child.stdin.on("error", (error) => finish(error));
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_096); });
  child.on("close", () => finish(new Error(`hc ${method} closed before replying: ${stderr}`)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 2 * 1024 * 1024) return finish(new Error("hc document reply exceeds 2 MiB"));
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      try {
        const response = JSON.parse(line);
        if (response.id !== 1) continue;
        if (response.error) {
          finish(new CoreRpcError(response.error.message, response.error.data?.kind));
        } else if (Object.hasOwn(response, "result")) {
          finish(undefined, response.result);
        } else {
          finish(new Error("hc returned a malformed document reply"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
});

type JsonObject = Record<string, unknown>;
type Tab = JsonObject & { id: string; name?: string; root: JsonObject };
type Space = JsonObject & { id: string; tabs: Tab[] };
type Layout = JsonObject & { spaces: Space[] };

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function layout(value: unknown): Layout {
  if (value === null) return { spaces: [] };
  if (!object(value) || !Array.isArray(value.spaces) || !value.spaces.every((space) =>
    object(space) && typeof space.id === "string" && Array.isArray(space.tabs) && space.tabs.every((tab) =>
      object(tab) && typeof tab.id === "string" && object(tab.root)))) {
    throw new Error("Unsupported herdr-app document; leaving the existing layout untouched.");
  }
  return value as Layout;
}

function hasTerminal(node: unknown, address: string): boolean {
  if (!object(node)) return false;
  if (object(node.content) && node.content.terminal === address) return true;
  return Array.isArray(node.children) && node.children.some((child) => hasTerminal(child, address));
}

function tab(id: string, name: string, address: string): Tab {
  return { id, name, root: { id, type: "row", children: [
    { id: `p${randomUUID().replaceAll("-", "")}`, type: "block", content: { terminal: address } },
  ] } };
}

export type ForkPlacement = {
  source: string;
  terminal: string;
  spaceId: string;
  tabId: string;
  name: string;
  cwd: string;
};

// This is the same core-owned document Moshi's headless workspace driver reads.
// Retry only explicit version conflicts. A timeout has an unknown write outcome:
// preserve the terminal and report it rather than launching or writing again.
export async function registerFork(request: CoreRequest, placement: ForkPlacement): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await request("doc.get", { name: "herdr-app" });
    if (!object(snapshot) || !Number.isSafeInteger(snapshot.version) || Number(snapshot.version) < 0) {
      throw new Error("Invalid core document version; leaving the existing layout untouched.");
    }
    const value = layout(structuredClone(snapshot.value));
    const existing = value.spaces.find((space) => space.tabs.some((tab) => hasTerminal(tab.root, placement.terminal)));
    if (existing) return existing.id;
    // The saved layout is authoritative if a terminal's labels are stale.
    let space = value.spaces.find((space) => space.tabs.some((tab) => hasTerminal(tab.root, placement.source)))
      ?? value.spaces.find((space) => space.id === placement.spaceId);
    if (!space) {
      space = { id: placement.spaceId, name: "", folder: placement.cwd, tabs: [
        tab(`tb${randomUUID().replaceAll("-", "")}`, "", placement.source),
      ] };
      value.spaces.push(space);
    }
    if (value.spaces.some((space) => space.tabs.some((tab) => tab.id === placement.tabId))) {
      throw new Error("Fork tab id already exists; leaving the existing layout untouched.");
    }
    space.tabs.push(tab(placement.tabId, placement.name, placement.terminal));
    try {
      await request("doc.set", { name: "herdr-app", version: snapshot.version, value });
      return space.id;
    } catch (error) {
      if (!(error instanceof CoreRpcError) || error.kind !== "conflict") throw error;
    }
  }
  throw new Error("Herdr layout kept changing; fork remains live but could not be registered. Inspect it before retrying.");
}
