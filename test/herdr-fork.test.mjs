import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHfork as register } from "../extensions/herdr-fork.ts";
import { CoreRpcError } from "../extensions/core-layout.ts";

const branch = [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Design the API" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "Here is the design" }] } },
  { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "Implement it" }] } },
  { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "Implementation details" }] } },
];

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hfork-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.jsonl");
  const header = { type: "session", version: options.version ?? 3, id: "original-session", cwd: "/old/path" };
  const original = [header, ...branch, { type: "message", id: "other-branch" }]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(source, original);
  const envKeys = ["HC_TERMINAL_ID", "HERDR_ENV", "HERDR_WORKSPACE_ID"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HC_TERMINAL_ID = "t1";
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_WORKSPACE_ID;

  const calls = [];
  const notifications = [];
  let handler;
  let launch;
  let adoptionReads = 0;
  let document = { spaces: options.noSpace ? [] : [{
    id: "source-space", name: "Source workspace", tabs: [{
      id: "source-tab", name: "Source tab", root: { type: "block", content: { terminal: "t1" } },
    }],
  }] };
  let version = 1;
  const documentCalls = [];
  const request = async (method, params) => {
    documentCalls.push({ method, params: structuredClone(params) });
    if (options.documentError) throw options.documentError;
    if (method === "doc.get") return { value: structuredClone(document), version };
    assert.equal(method, "doc.set");
    if (params.version !== version) throw new CoreRpcError("conflict", "conflict");
    document = structuredClone(params.value);
    return { version: ++version };
  };
  const listing = (adopted) => ({ spaces: [{
    id: "source-space", machine: null, active: false,
    tabs: adopted && launch ? [{
      id: launch.tab, active: false, terminals: [{ terminal: "t2" }],
    }] : [],
  }] });
  register({
    registerCommand(name, command) {
      assert.equal(name, "hfork");
      handler = command.handler;
    },
    async exec(command, args, execOptions) {
      const call = { command, args, options: execOptions };
      calls.push(call);
      const override = await options.exec?.(call);
      if (override !== undefined) return override;
      let response;
      if (command === "hc" && args[0] === "get") {
        response = { address: args[1], state: "live", labels: options.noSpace ? {} : { "herdr.space": "source-space" } };
      } else if (command === "bash" && args[0] === "-lc" && args[1] === "command -v pi") {
        return { code: 0, stdout: "/resolved/pi\n", stderr: "" };
      } else if (command === "herdr-app" && args[0] === "ls") {
        if (options.noApp) return { code: 127, stdout: "", stderr: "spawn herdr-app ENOENT" };
        response = listing(Boolean(launch) && adoptionReads++ >= (options.adoptionDelay ?? 0));
      } else if (command === "hc" && args[0] === "run") {
        const tabArg = args.find((arg) => String(arg).startsWith("herdr.tab="));
        launch = tabArg ? { tab: tabArg.slice("herdr.tab=".length) } : {};
        response = { address: "t2", state: "live" };
      } else if (command === "herdr-app" && args[0] === "do" && args[1] === "tab.rename") {
        response = {};
      } else {
        assert.fail(`Unexpected command: ${command} ${JSON.stringify(args)}`);
      }
      return { code: 0, stdout: JSON.stringify(response), stderr: "" };
    },
  }, request);
  const ctx = {
    mode: "tui", cwd: dir,
    sessionManager: {
      getSessionFile: () => options.noSession ? undefined : source,
      getBranch: () => options.branch ?? branch,
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      select: async (_title, items) => options.cancelStage ? undefined : items[options.stage ?? 0],
      input: async () => Object.hasOwn(options, "name") ? options.name : "Side discussion",
    },
  };
  return {
    calls, documentCalls, document: () => document, notifications, source, dir, original, ctx,
    run: () => handler("", ctx),
    forks: async () => (await readdir(dir)).filter((file) => file !== "source.jsonl"),
    fork: async () => {
      const files = (await readdir(dir)).filter((file) => file !== "source.jsonl");
      assert.equal(files.length, 1);
      return (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

function success(f) {
  assert.deepEqual(f.notifications.map((item) => item.level), ["info", "info"]);
  assert.match(f.notifications.at(-1).message, /Opened/);
}

function failure(f, pattern) {
  assert.equal(f.notifications.at(-1).level, "error");
  assert.match(f.notifications.at(-1).message, pattern);
}

test("forks the active branch in the source space without legacy environment or focus commands", async (t) => {
  const name = "Design review 'quotes' $(touch /tmp/nope) `literal` ; --help π";
  const f = await fixture(t, { name });
  await f.run();
  success(f);
  const entries = await f.fork();
  assert.notEqual(entries[0].id, "original-session");
  assert.equal(entries[0].parentSession, f.source);
  assert.equal(entries[0].cwd, f.dir);
  assert.deepEqual(entries.slice(1), branch);
  assert.equal(await readFile(f.source, "utf8"), f.original);
  const [file] = await f.forks();
  assert.equal((await stat(join(f.dir, file))).mode & 0o777, 0o600);
  const launch = f.calls.find((call) => call.args[0] === "run");
  assert.equal(launch.command, "hc");
  for (const flag of ["--bg", "--json", "--no-parent", "--no-notify"]) assert.ok(launch.args.includes(flag));
  assert.ok(launch.args.includes("herdr.space=source-space"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--") + 1), [
    "/resolved/pi", "--session", join(f.dir, file), "--name", name,
  ]);
  const rename = f.calls.find((call) => call.args[1] === "tab.rename");
  assert.deepEqual(JSON.parse(rename.args[2]), {
    id: launch.args.find((arg) => arg.startsWith("herdr.tab=")).slice("herdr.tab=".length), name,
  });
  assert.ok(f.calls.every((call) => ["hc", "herdr-app", "bash"].includes(call.command)));
  assert.ok(f.calls.every((call) => !["tab.new", "space.select", "tab.select", "pane.focus"].includes(call.args[1])));
});

test("earlier-stage fork includes the selected user message and excludes later responses", async (t) => {
  const f = await fixture(t, { stage: 2 });
  await f.run();
  success(f);
  assert.deepEqual((await f.fork()).slice(1), branch.slice(0, 3));
});

test("waits for app adoption without repeating the launch", async (t) => {
  const f = await fixture(t, { adoptionDelay: 2 });
  await f.run();
  success(f);
  assert.equal(f.calls.filter((call) => call.args[0] === "run").length, 1);
  // One availability probe before the prompts, then three adoption reads.
  assert.equal(f.calls.filter((call) => call.args[0] === "ls").length, 4);
});

test("without herdr-app it registers a named tab in the source workspace", async (t) => {
  const f = await fixture(t, { noApp: true });
  await f.run();
  success(f);
  assert.match(f.notifications.at(-1).message, /hc attach hfork-/);
  assert.match(f.notifications.at(-1).message, /in your workspace/);
  const launch = f.calls.find((call) => call.args[0] === "run");
  assert.ok(launch);
  assert.ok(launch.args.includes("herdr.space=source-space"));
  assert.ok(launch.args.some((arg) => String(arg).startsWith("herdr.tab=tb")));
  const forkTab = f.document().spaces[0].tabs[1];
  assert.equal(forkTab.name, "Side discussion");
  assert.equal(forkTab.root.children[0].content.terminal, "t2");
  assert.equal(f.documentCalls.filter((call) => call.method === "doc.set").length, 1);
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--") + 1), [
    "/resolved/pi", "--session", join(f.dir, (await f.forks())[0]), "--name", "Side discussion",
  ]);
  const launchName = launch.args[launch.args.indexOf("--name") + 1];
  assert.match(launchName, /^hfork-[0-9a-f]{8}$/);
  // The app is probed exactly once and never asked to adopt or rename.
  assert.equal(f.calls.filter((call) => call.command === "herdr-app").length, 1);
  assert.deepEqual((await f.fork()).slice(1), branch);
  assert.equal(await readFile(f.source, "utf8"), f.original);
});

test("without an app or saved source space it registers a new workspace containing source and fork", async (t) => {
  const f = await fixture(t, { noApp: true, noSpace: true });
  await f.run();
  success(f);
  const launch = f.calls.find((call) => call.args[0] === "run");
  assert.ok(launch);
  const space = f.document().spaces[0];
  assert.equal(space.folder, f.dir);
  assert.equal(space.tabs.length, 2);
  assert.equal(space.tabs[0].root.children[0].content.terminal, "t1");
  assert.equal(space.tabs[1].root.children[0].content.terminal, "t2");
  assert.ok(launch.args.includes(`herdr.space=${space.id}`));
  assert.equal(f.calls.filter((call) => call.command === "herdr-app").length, 1);
});

test("a headless layout failure reports the live terminal without launching again", async (t) => {
  const f = await fixture(t, { noApp: true, documentError: new Error("layout unavailable") });
  await f.run();
  failure(f, /layout unavailable/);
  assert.match(f.notifications.at(-1).message, /Terminal: hfork-/);
  assert.equal(f.calls.filter((call) => call.args[0] === "run").length, 1);
  assert.equal((await f.forks()).length, 1);
});

test("a dead source terminal is refused before any prompt", async (t) => {
  const f = await fixture(t, { exec: ({ args }) => args[0] === "get"
    ? { code: 0, stdout: '{"address":"t1","state":"finished"}' } : undefined });
  await f.run();
  failure(f, /not live/);
  assert.deepEqual(await f.forks(), []);
});

for (const [label, options] of [
  ["stage cancellation", { cancelStage: true }],
  ["name cancellation", { name: undefined }],
  ["empty name", { name: "   " }],
]) {
  test(`${label} creates no fork or terminal`, async (t) => {
    const f = await fixture(t, options);
    await f.run();
    assert.deepEqual(await f.forks(), []);
    assert.ok(!f.calls.some((call) => call.args[0] === "run"));
    assert.deepEqual(f.notifications, []);
  });
}

for (const [label, setup, pattern] of [
  ["missing core terminal", () => delete process.env.HC_TERMINAL_ID, /herdr-core terminal/],
  ["noninteractive mode", (f) => { f.ctx.mode = "rpc"; }, /interactive Pi/],
  ["unsaved session", (f) => { f.ctx.sessionManager.getSessionFile = () => undefined; }, /No saved session/],
  ["empty conversation", (f) => { f.ctx.sessionManager.getBranch = () => []; }, /Nothing in this conversation/],
]) {
  test(`${label} stops before contacting Herdr`, async (t) => {
    const f = await fixture(t);
    setup(f);
    await f.run();
    assert.match(f.notifications.at(-1).message, pattern);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.forks(), []);
  });
}

for (const [label, exec, pattern] of [
  ["unlabeled terminal", ({ command }) => command === "hc" ? { code: 0, stdout: '{"state":"live","labels":{}}' } : undefined, /not in a Herdr space/],
  ["missing app space", ({ command }) => command === "herdr-app" ? { code: 0, stdout: '{"spaces":[]}' } : undefined, /space is not in this herdr-app window/],
  ["unavailable CLI", () => { throw new Error("spawn hc ENOENT"); }, /ENOENT/],
  ["CLI error envelope", () => ({ code: 0, stdout: '{"error":{"kind":"not_found"}}' }), /not_found/],
  ["malformed response", () => ({ code: 0, stdout: "not JSON" }), /JSON/],
]) {
  test(`${label} is reported before creating a fork`, async (t) => {
    const f = await fixture(t, { exec });
    await f.run();
    failure(f, pattern);
    assert.deepEqual(await f.forks(), []);
  });
}

test("unsupported session formats are left untouched", async (t) => {
  const f = await fixture(t, { version: 4 });
  await f.run();
  failure(f, /Unsupported session format/);
  assert.deepEqual(await f.forks(), []);
  assert.equal(await readFile(f.source, "utf8"), f.original);
});

test("a launch timeout preserves the fork and recovery addresses without retrying", async (t) => {
  const f = await fixture(t, { exec: ({ args }) => args[0] === "run"
    ? { code: -1, stdout: "", stderr: "launch timed out" } : undefined });
  await f.run();
  failure(f, /launch timed out/);
  assert.match(f.notifications.at(-1).message, /Terminal: hfork-/);
  assert.match(f.notifications.at(-1).message, /Tab: tb/);
  assert.match(f.notifications.at(-1).message, /Fork: /);
  assert.equal((await f.forks()).length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === "run").length, 1);
});

test("a rename failure preserves the launched conversation and is not retried", async (t) => {
  const f = await fixture(t, { exec: ({ args }) => args[1] === "tab.rename"
    ? { code: 1, stdout: "", stderr: "app unavailable" } : undefined });
  await f.run();
  failure(f, /app unavailable/);
  assert.equal((await f.forks()).length, 1);
  assert.equal(f.calls.filter((call) => call.args[1] === "tab.rename").length, 1);
});

test("an immediately exited Pi terminal is reported as a failure", async (t) => {
  const f = await fixture(t, { exec: ({ command, args }) => command === "hc" && args[0] === "get" && args[1] === "t2"
    ? { code: 0, stdout: '{"state":"finished","exit_code":127}' } : undefined });
  await f.run();
  failure(f, /exited \(code 127\)/);
  assert.equal((await f.forks()).length, 1);
});

test("an unresolvable pi path is reported before launching", async (t) => {
  const f = await fixture(t, { exec: ({ command }) => command === "bash"
    ? { code: 1, stdout: "", stderr: "command not found" } : undefined });
  await f.run();
  failure(f, /resolve the pi executable/);
  assert.equal((await f.forks()).length, 1);
  assert.ok(!f.calls.some((call) => call.args[0] === "run"));
});
