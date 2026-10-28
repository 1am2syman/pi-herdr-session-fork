import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hfork", {
    description: "Fork a conversation stage into a named Herdr tab",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
        ctx.ui.notify("/hfork requires Pi running inside Herdr.", "error");
        return;
      }
      const source = ctx.sessionManager.getSessionFile();
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (!source || !workspace) {
        ctx.ui.notify("No saved session or Herdr workspace to fork.", "error");
        return;
      }

      // Capture only the active branch. Never switch or write to the source session.
      const branch = ctx.sessionManager.getBranch();
      if (!branch.length) {
        ctx.ui.notify("Nothing in this conversation to fork yet.", "warning");
        return;
      }
      const stages = [{ label: "Current stage (latest)", end: branch.length }];
      for (const [index, entry] of branch.entries()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const content = entry.message.content;
        const text = typeof content === "string" ? content : content
          .filter((part) => part.type === "text").map((part) => part.text).join(" ");
        stages.push({
          label: `${stages.length}. Through user message: ${text.replace(/\s+/g, " ").slice(0, 100) || "[attachment]"}`,
          end: index + 1,
        });
      }
      const selected = await ctx.ui.select("Fork through which stage?", stages.map((s) => s.label));
      if (selected === undefined) return;
      const stage = stages.find((s) => s.label === selected);
      if (!stage) return;
      const name = (await ctx.ui.input("Name the new session and tab", "Side discussion"))?.trim();
      if (!name) return;

      let forkFile: string | undefined;
      let tabId: string | undefined;
      try {
        const header = JSON.parse((await readFile(source, "utf8")).split("\n", 1)[0]);
        if (header.type !== "session" || header.version !== 3) {
          throw new Error("Unsupported session format (expected version 3).");
        }
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        forkFile = join(dirname(source), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
        await writeFile(forkFile, [
          { ...header, id, timestamp, cwd: ctx.cwd, parentSession: source },
          ...branch.slice(0, stage.end),
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });

        const herdr = async (args: string[]) => {
          const result = await pi.exec("herdr", args, { cwd: ctx.cwd, timeout: 65_000 });
          if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Herdr command failed.");
          const response = JSON.parse(result.stdout);
          if (response.error) throw new Error(JSON.stringify(response.error));
          return response.result;
        };
        ctx.ui.notify(`Opening ${name}…`, "info");
        const created = await herdr([
          "tab", "create", "--workspace", workspace, "--cwd", ctx.cwd,
          "--label", name, "--no-focus",
        ]);
        tabId = created.tab.tab_id;
        await herdr([
          "agent", "start", `hfork-${id.slice(0, 8)}`, "--kind", "pi",
          "--pane", created.root_pane.pane_id, "--timeout", "60000",
          "--", "--session", forkFile, "--name", name,
        ]);
        ctx.ui.notify(`Opened “${name}” in ${tabId}. Your current session stays here.`, "info");
      } catch (error) {
        // Preserve partial results: a timed-out launch may still have succeeded.
        ctx.ui.notify([
          `/hfork failed: ${error instanceof Error ? error.message : String(error)}`,
          tabId && `Tab: ${tabId}`, forkFile && `Fork: ${forkFile}`,
        ].filter(Boolean).join("\n"), "error");
      }
    },
  });
}
