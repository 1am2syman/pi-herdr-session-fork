import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CoreTerminal = {
  address: string;
  state: string;
  exit_code?: number | null;
  labels?: Record<string, string>;
};

type AppListing = {
  spaces: {
    id: string;
    machine: string | null;
    tabs: { id: string; terminals: { terminal: string }[] }[];
  }[];
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hfork", {
    description: "Fork a conversation stage into a named Herdr tab",
    handler: async (_args, ctx) => {
      const terminal = process.env.HC_TERMINAL_ID;
      if (ctx.mode !== "tui" || !terminal) {
        ctx.ui.notify("/hfork requires interactive Pi in a herdr-core terminal shown in herdr-app.", "error");
        return;
      }
      const source = ctx.sessionManager.getSessionFile();
      if (!source) {
        ctx.ui.notify("No saved session to fork.", "error");
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
      let forkFile: string | undefined;
      let tabId: string | undefined;
      let terminalName: string | undefined;
      try {
        const execJSON = async <T>(command: string, args: string[], timeout = 5_000): Promise<T> => {
          const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout });
          if (result.code !== 0) {
            throw new Error(`${command}: ${result.stderr || result.stdout || "command failed or timed out."}`);
          }
          const response = JSON.parse(result.stdout);
          if (response?.error) throw new Error(`${command}: ${JSON.stringify(response.error)}`);
          return response as T;
        };

        const current = await execJSON<CoreTerminal>("hc", ["get", terminal, "--json"]);
        const space = current.labels?.["herdr.space"];
        if (current.state !== "live" || !space) {
          throw new Error("This terminal is not in a Herdr space. Open Pi in a herdr-app tab first.");
        }
        const app = await execJSON<AppListing>("herdr-app", ["ls"]);
        if (!app.spaces.some((entry) => entry.id === space && !entry.machine)) {
          throw new Error("The current terminal's space is not in this herdr-app window. Run /hfork on the same machine as the app.");
        }

        const selected = await ctx.ui.select("Fork through which stage?", stages.map((s) => s.label));
        if (selected === undefined) return;
        const stage = stages.find((s) => s.label === selected);
        if (!stage) return;
        const name = (await ctx.ui.input("Name the new session and tab", "Side discussion"))?.trim();
        if (!name) return;

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

        ctx.ui.notify(`Opening ${name}…`, "info");
        terminalName = `hfork-${id.slice(0, 8)}`;
        tabId = `tb${id.replace(/-/g, "")}`;
        // App adoption through labels leaves focus alone. A sibling conversation
        // has no parent so closing the source terminal cannot end the fork.
        const created = await execJSON<CoreTerminal>("hc", [
          "run", "--bg", "--json", "--no-parent", "--no-notify",
          "--name", terminalName, "--cwd", ctx.cwd,
          "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tabId}`,
          "--", "pi", "--session", forkFile, "--name", name,
        ], 65_000);
        if (!created.address || created.state !== "live") {
          throw new Error("herdr-core did not return a live fork terminal.");
        }

        // Adoption is asynchronous. Only retry reads; never repeat a launch or
        // rename whose outcome could be unknown after a timeout.
        const deadline = Date.now() + 5_000;
        for (;;) {
          const listing = await execJSON<AppListing>("herdr-app", ["ls"]);
          const adopted = listing.spaces.some((entry) => entry.id === space && !entry.machine
            && entry.tabs.some((tab) => tab.id === tabId
              && tab.terminals.some((item) => item.terminal === created.address)));
          if (adopted) break;
          if (Date.now() >= deadline) throw new Error("Timed out waiting for herdr-app to show the fork terminal.");
          await setTimeout(100);
        }
        await execJSON("herdr-app", ["do", "tab.rename", JSON.stringify({ id: tabId, name })]);
        const running = await execJSON<CoreTerminal>("hc", ["get", created.address, "--json"]);
        if (running.state !== "live") {
          throw new Error(`Fork terminal ${created.address} exited (code ${running.exit_code ?? "unknown"}). Inspect it with hc read ${created.address}.`);
        }
        ctx.ui.notify(`Opened “${name}” in ${tabId}. Your current session stays here.`, "info");
      } catch (error) {
        // Preserve partial results: a timed-out launch may still have succeeded.
        ctx.ui.notify([
          `/hfork failed: ${error instanceof Error ? error.message : String(error)}`,
          terminalName && `Terminal: ${terminalName} (inspect with hc get ${terminalName})`,
          tabId && `Tab: ${tabId}`, forkFile && `Fork: ${forkFile}`,
        ].filter(Boolean).join("\n"), "error");
      }
    },
  });
}
