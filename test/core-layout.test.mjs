import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFork, CoreRpcError } from "../extensions/core-layout.ts";

const placement = { source: "t1", terminal: "t2", spaceId: "source-space", tabId: "fork-tab", name: "Review π", cwd: "/project" };
const sourceTab = { id: "source-tab", name: "Original", root: { type: "row", children: [
  { type: "block", content: { terminal: "t1" }, customField: "keep" },
] } };
const initial = () => ({ customMetadata: { keep: true }, spaces: [
  { id: "source-space", name: "Project", tabs: [structuredClone(sourceTab)], otherField: [1, 2] },
  { id: "other-space", tabs: [] },
] });

function store(value = initial()) {
  let document = value;
  let version = 3;
  const calls = [];
  return {
    calls,
    value: () => document,
    update(fn) { fn(document); version++; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "doc.get") return { value: structuredClone(document), version };
      assert.equal(method, "doc.set");
      if (params.version !== version) throw new CoreRpcError("version mismatch", "conflict");
      document = structuredClone(params.value);
      return { version: ++version };
    },
  };
}

test("registration appends a named fork while preserving source tabs and unknown metadata", async () => {
  const s = store();
  assert.equal(await registerFork(s.request, placement), "source-space");
  const d = s.value();
  assert.deepEqual(d.spaces[0].tabs[0], sourceTab);
  assert.deepEqual(d.customMetadata, { keep: true });
  assert.deepEqual(d.spaces[0].otherField, [1, 2]);
  assert.deepEqual(d.spaces[1], { id: "other-space", tabs: [] });
  assert.equal(d.spaces[0].tabs[1].name, placement.name);
  assert.equal(d.spaces[0].tabs[1].root.children[0].content.terminal, "t2");
  assert.equal(d.spaces[0].tabs[1].id, "fork-tab");
});

test("an explicit conflict rereads the document and retains a concurrent writer's tab", async () => {
  const s = store();
  let firstWrite = true;
  const request = async (method, params) => {
    if (method === "doc.set" && firstWrite) {
      firstWrite = false;
      s.update((d) => d.spaces[0].tabs.push({ id: "concurrent", root: { type: "block", content: { terminal: "t3" } } }));
    }
    return s.request(method, params);
  };
  await registerFork(request, placement);
  assert.deepEqual(s.value().spaces[0].tabs.map((tab) => tab.id), ["source-tab", "concurrent", "fork-tab"]);
  assert.equal(s.calls.filter((call) => call.method === "doc.set").length, 2);
});

test("an already registered terminal is idempotent and follows the saved space over stale labels", async () => {
  const s = store();
  assert.equal(await registerFork(s.request, { ...placement, spaceId: "stale-space" }), "source-space");
  await registerFork(s.request, placement);
  assert.equal(s.calls.filter((call) => call.method === "doc.set").length, 1);
});

test("an uninitialized document creates a space containing source and fork", async () => {
  const s = store(null);
  await registerFork(s.request, placement);
  assert.equal(s.value().spaces[0].tabs.length, 2);
  assert.equal(s.value().spaces[0].tabs[0].root.children[0].content.terminal, "t1");
});

for (const value of [{ spaces: "broken" }, { spaces: [{ id: "source-space", tabs: [{ id: "x", root: null }] }] }, {}]) {
  test(`unsupported layout is preserved: ${JSON.stringify(value)}`, async () => {
    const s = store(value);
    await assert.rejects(registerFork(s.request, placement), /Unsupported herdr-app document/);
    assert.equal(s.calls.filter((call) => call.method === "doc.set").length, 0);
    assert.deepEqual(s.value(), value);
  });
}

test("a timeout after an accepted write is not retried", async () => {
  const s = store();
  const request = async (method, params) => {
    const result = await s.request(method, params);
    if (method === "doc.set") throw new Error("transport timed out");
    return result;
  };
  await assert.rejects(registerFork(request, placement), /transport timed out/);
  assert.equal(s.calls.filter((call) => call.method === "doc.set").length, 1);
  assert.equal(s.value().spaces[0].tabs[1].id, "fork-tab");
});

test("repeated explicit conflicts stop after five attempts", async () => {
  const s = store();
  let writes = 0;
  const request = async (method, params) => {
    if (method === "doc.set") {
      writes++;
      throw new CoreRpcError("conflict", "conflict");
    }
    return s.request(method, params);
  };
  await assert.rejects(registerFork(request, placement), /kept changing/);
  assert.equal(writes, 5);
});
