import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../extensions/herdr-fork.ts";

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
        response = { address: args[1], state: "live", labels: { "herdr.space": "source-space" } };
      } else if (command === "herdr-app" && args[0] === "ls") {
        response = listing(Boolean(launch) && adoptionReads++ >= (options.adoptionDelay ?? 0));
      } else if (command === "hc" && args[0] === "run") {
        launch = { tab: args.find((arg) => arg.startsWith("herdr.tab=")).slice("herdr.tab=".length) };
        response = { address: "t2", state: "live" };
      } else if (command === "herdr-app" && args[0] === "do" && args[1] === "tab.rename") {
        response = {};
      } else {
        assert.fail(`Unexpected command: ${command} ${JSON.stringify(args)}`);
      }
      return { code: 0, stdout: JSON.stringify(response), stderr: "" };
    },
  });
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
    calls, notifications, source, dir, original, ctx,
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
    "pi", "--session", join(f.dir, file), "--name", name,
  ]);
  const rename = f.calls.find((call) => call.args[1] === "tab.rename");
  assert.deepEqual(JSON.parse(rename.args[2]), {
    id: launch.args.find((arg) => arg.startsWith("herdr.tab=")).slice("herdr.tab=".length), name,
  });
  assert.ok(f.calls.every((call) => call.command === "hc" || call.command === "herdr-app"));
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
  assert.equal(f.calls.filter((call) => call.args[0] === "ls").length, 4);
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
