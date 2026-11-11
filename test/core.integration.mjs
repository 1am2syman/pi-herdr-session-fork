import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import register from "../extensions/herdr-fork.ts";
import { coreRequest, CoreRpcError } from "../extensions/core-layout.ts";

const exec = promisify(execFile);

for (const appAvailable of [true, false]) {
test(`real hc launches an independent Pi fork (${appAvailable ? "app adoption" : "Moshi headless document"})`, { timeout: 45_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hfork-core-test-"));
  const overrides = {
    HC_SESSION: "hfork-integration",
    HC_TERMINAL_ID: undefined,
    HC_SOCKET: undefined,
    HC_TERMINAL_SOCKET: undefined,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_RUNTIME_DIR: dir,
    HERDR_APP_HOME: join(dir, "app"),
    PI_CODING_AGENT_DIR: join(dir, "pi"),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const hc = async (...args) => JSON.parse((await exec("hc", [...args, "--json"], { timeout: 20_000 })).stdout);
  const terminals = [];
  t.after(async () => {
    try {
      // Every address here belongs to the scratch core, never the user's core.
      for (const terminal of terminals) {
        await hc("kill", terminal).catch(() => {});
        await hc("rm", terminal).catch(() => {});
      }
      await hc("server", "stop");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
  const sourceTerminal = JSON.parse((await exec("hc", [
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--label", "herdr.space=source-space",
    "--", process.execPath, "-e", "setInterval(() => {}, 1000)",
  ], { timeout: 10_000 })).stdout);
  terminals.push(sourceTerminal.address);
  process.env.HC_TERMINAL_ID = sourceTerminal.address;
  const initialLayout = { spaces: [{ id: "source-space", name: "Source", tabs: [{
    id: "source-tab", name: "Source tab", root: { id: "source-pane", type: "block", content: { terminal: sourceTerminal.address } },
  }] }], extensionMetadata: { preserve: true } };
  await coreRequest("doc.set", { name: "herdr-app", version: 0, value: initialLayout });
  await assert.rejects(coreRequest("doc.set", { name: "herdr-app", version: 0, value: null }),
    (error) => error instanceof CoreRpcError && error.kind === "conflict",
    "Real core conflict envelopes must be classified without overwriting the layout");

  const source = join(dir, "source.jsonl");
  const timestamp = new Date().toISOString();
  const branch = [{
    type: "message", id: "abcdef01", parentId: null, timestamp,
    message: { role: "user", content: "Context for the side conversation", timestamp: Date.now() },
  }];
  const original = [{ type: "session", version: 3, id: "original", cwd: dir, timestamp }, ...branch]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(source, original);
  const name = "Side review π 'literal' $() ; --help";
  let handler;
  let launched;
  let renamed;
  const notifications = [];
  register({
    registerCommand(_name, command) { handler = command.handler; },
    async exec(command, args, options) {
      if (command === "herdr-app") {
        if (!appAvailable) return { code: 2, stdout: "", stderr: "herdr-app: no Herdr window: Connection refused" };
        if (args[0] === "ls") {
          // App transport is simulated; adoption uses real core metadata.
          const terminal = launched ? await hc("get", launched.address) : undefined;
          return { code: 0, stdout: JSON.stringify({ spaces: [{
            id: "source-space", machine: null, tabs: terminal ? [{
              id: terminal.labels["herdr.tab"], terminals: [{ terminal: terminal.address }],
            }] : [],
          }] }), stderr: "" };
        }
        assert.deepEqual(args.slice(0, 2), ["do", "tab.rename"]);
        renamed = JSON.parse(args[2]);
        return { code: 0, stdout: "{}", stderr: "" };
      }
      if (command === "bash") {
        const result = await exec("bash", args, { ...options, encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      }
      assert.equal(command, "hc");
      const result = await exec(command, args, { ...options, encoding: "utf8" });
      if (args[0] === "run") {
        launched = JSON.parse(result.stdout);
        terminals.push(launched.address);
      }
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    },
  });
  await handler("", {
    mode: "tui", cwd: dir,
    sessionManager: { getSessionFile: () => source, getBranch: () => branch },
    ui: {
      select: async (_title, items) => items[0], input: async () => name,
      notify: (message, level) => notifications.push({ message, level }),
    },
  });
  assert.deepEqual(notifications.map((item) => item.level), ["info", "info"], JSON.stringify(notifications));
  const ready = await hc("wait", launched.address, "--timeout", "15");
  assert.notEqual(ready.reason, "timeout", JSON.stringify(ready));
  const terminal = await hc("get", launched.address);
  assert.equal(terminal.state, "live");
  assert.equal(terminal.status?.app, "pi", JSON.stringify(terminal.status));
  assert.equal(terminal.parent, null);
  assert.equal(terminal.die_with_parent, false);
  assert.equal(terminal.labels["herdr.space"], "source-space");
  if (appAvailable) {
    assert.equal(renamed.id, terminal.labels["herdr.tab"]);
    assert.equal(renamed.name, name);
  } else {
    assert.equal(renamed, undefined);
    const document = await coreRequest("doc.get", { name: "herdr-app" });
    const space = document.value.spaces.find((space) => space.id === "source-space");
    const forkTab = space.tabs.find((tab) => JSON.stringify(tab.root).includes(`\"terminal\":\"${terminal.address}\"`));
    assert.ok(forkTab, "Live fork must appear in the document consumed by Moshi's sidebar without herdr-app");
    assert.equal(forkTab.name, name);
    assert.equal(forkTab.id, terminal.labels["herdr.tab"]);
    assert.deepEqual(space.tabs[0], initialLayout.spaces[0].tabs[0]);
    assert.deepEqual(document.value.extensionMetadata, initialLayout.extensionMetadata);
    assert.match(notifications.at(-1).message, /workspace/);
  }
  assert.ok(terminal.argv[0].startsWith("/"), "Daemon must receive an absolute Pi executable");
  assert.equal(terminal.argv[1], "--session");
  assert.deepEqual(terminal.argv.slice(-2), ["--name", name]);
  const fork = (await readFile(terminal.argv[2], "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(fork[0].parentSession, source);
  assert.equal(fork[1].message.content, branch[0].message.content);
  assert.equal(await readFile(source, "utf8"), original);
  await hc("kill", sourceTerminal.address);
  assert.equal((await hc("get", launched.address)).state, "live");
});
}
