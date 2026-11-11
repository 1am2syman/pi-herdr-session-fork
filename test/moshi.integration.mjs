// Opt-in live check: creates one temporary fork in the caller's real workspace,
// queries Moshi's sidebar API, then removes only that fork and its layout entry.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import register from "../extensions/herdr-fork.ts";
import { coreRequest, CoreRpcError } from "../extensions/core-layout.ts";

const exec = promisify(execFile);
const port = process.env.HFORK_MOSH_PORT;
const sourceTerminal = process.env.HC_TERMINAL_ID;
const api = `http://127.0.0.1:${process.env.HFORK_GATEWAY_PORT ?? "24543"}/v1/workspaces?moshPort=${port}`;

async function workspacePanes() {
  const response = await fetch(api, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, await response.clone().text());
  const tree = await response.json();
  assert.equal(tree.kind, "hc");
  return tree.groups.flatMap((group) => group.children.flatMap((tab) =>
    (tab.panes ?? []).map((pane) => ({ pane, tab, group }))));
}

function prune(node, terminal) {
  if (node.content?.terminal === terminal) return null;
  if (Array.isArray(node.children)) {
    node.children = node.children.map((child) => prune(child, terminal)).filter(Boolean);
    if (!node.children.length) return null;
  }
  return node;
}

async function removeTestPane(address) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const document = await coreRequest("doc.get", { name: "herdr-app" });
    for (const space of document.value.spaces) {
      space.tabs = space.tabs.filter((tab) => { tab.root = prune(tab.root, address); return tab.root !== null; });
    }
    try {
      await coreRequest("doc.set", { name: "herdr-app", version: document.version, value: document.value });
      return;
    } catch (error) {
      if (!(error instanceof CoreRpcError) || error.kind !== "conflict") throw error;
    }
  }
  throw new Error("Could not clean up test pane after repeated version conflicts");
}

test("actual Moshi sidebar discovers a live fork without herdr-app", { timeout: 60_000 }, async (t) => {
  assert.ok(port && /^\d+$/.test(port), "Set HFORK_MOSH_PORT to the active Mosh server UDP port");
  assert.ok(sourceTerminal, "Run from an existing hc terminal");
  const app = await exec("pgrep", ["-x", "herdr-app"]).then((r) => r.stdout, () => "");
  assert.equal(app, "", "Close herdr-app before this opt-in headless check");
  const source = JSON.parse((await exec("hc", ["get", sourceTerminal, "--json"])).stdout);
  const sourcePid = source.pid;
  assert.ok((await workspacePanes()).some(({ pane }) => pane.id === sourceTerminal), "Positive control: Moshi lists the source terminal");
  const dir = await mkdtemp(join(tmpdir(), "hfork-moshi-check-"));
  const file = join(dir, "source.jsonl");
  const timestamp = new Date().toISOString();
  const branch = [{ type: "message", id: "test-user", parentId: null, timestamp,
    message: { role: "user", content: "Temporary sidebar verification. Wait for input.", timestamp: Date.now() } }];
  const original = [{ type: "session", version: 3, id: "hfork-moshi-verification", cwd: source.cwd, timestamp }, ...branch]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(file, original, { mode: 0o600 });
  let handler;
  let created;
  const notifications = [];
  t.after(async () => {
    try {
      if (created) {
        await exec("hc", ["kill", created.address]);
        await removeTestPane(created.address);
        await exec("hc", ["rm", created.address]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  register({
    registerCommand(_name, command) { handler = command.handler; },
    async exec(command, args, options) {
      try {
        const result = await exec(command, args, options);
        if (command === "hc" && args[0] === "run") created = JSON.parse(result.stdout);
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
      }
    },
  });
  const name = "hfork sidebar verification";
  await handler("", {
    mode: "tui", cwd: source.cwd,
    sessionManager: { getSessionFile: () => file, getBranch: () => branch },
    ui: { select: async (_title, items) => items[0], input: async () => name,
      notify: (message, level) => notifications.push({ message, level }) },
  });
  assert.deepEqual(notifications.map((item) => item.level), ["info", "info"], JSON.stringify(notifications));
  let discovered;
  let running;
  for (let attempt = 0; attempt < 40; attempt++) {
    discovered = (await workspacePanes()).find(({ pane }) => pane.id === created.address);
    running = JSON.parse((await exec("hc", ["get", created.address, "--json"])).stdout);
    if (discovered && running.status?.app === "pi") break;
    await setTimeout(500);
  }
  assert.ok(discovered, "Fork must appear in the actual Moshi sidebar API");
  assert.equal(discovered.tab.label, name);
  assert.equal(running.state, "live");
  assert.equal(running.status?.app, "pi");
  assert.equal(running.parent, null);
  assert.equal(await readFile(file, "utf8"), original);
  const sourceAfter = JSON.parse((await exec("hc", ["get", sourceTerminal, "--json"])).stdout);
  assert.equal(sourceAfter.state, "live");
  assert.equal(sourceAfter.pid, sourcePid);
  console.log(`MOSHI_SIDEBAR_OK: ${created.address} appears as ${JSON.stringify(discovered.tab.label)}; Pi live; source PID unchanged`);
});
