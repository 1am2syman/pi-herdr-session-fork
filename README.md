# pi-herdr-session-fork

Open a side conversation from any stage of a [Pi](https://pi.dev) session in a named workspace tab, powered by **herdr-core** (`hc`). Forks appear in **Moshi's workspace sidebar without herdr-app running**. A running herdr-app can also adopt the fork into a tab. Your original session stays active, and focus stays in your current view.

One slash command, a stage picker, and a name prompt. No additional runtime packages beyond Pi and herdr-core; herdr-app is optional.

## Herdr support

This extension supports the current [Herdr](https://herdr.dev) stack:

| Component | Role |
| --- | --- |
| **herdr-core** (`hc`) | Runs independent fork terminals and stores the shared workspace layout |
| **Moshi** (optional client) | Shows the registered fork as a named workspace tab, including over a remote connection |
| **herdr-app** (optional client) | Adopts and names the fork in the original session's space |

herdr-core is required; herdr-app is optional. Run Pi inside a herdr-core terminal with `pi` and `hc` on `PATH`. With herdr-app running on the same machine, the fork is adopted into a named tab in your space. Without it, the extension registers the tab in the core's versioned `herdr-app` document, which Moshi's headless driver reads for its sidebar. No desktop window or Moshi-specific runtime dependency is required. The legacy `herdr` multiplexer is not supported.

## Install from Git

```bash
pi install git:github.com/1am2syman/pi-herdr-session-fork
```

Then run `/reload` in an existing Pi session, or start a new one.

For a project-only installation:

```bash
pi install --local git:github.com/1am2syman/pi-herdr-session-fork
```

Alternatively, clone the repository and install the local package:

```bash
git clone https://github.com/1am2syman/pi-herdr-session-fork.git
pi install ./pi-herdr-session-fork
```

If you previously copied `herdr-fork.ts` into `~/.pi/agent/extensions/`, move that standalone copy out of the extensions directory before installing this package, so `/hfork` is registered only once. Then run `/reload`.

If `/hfork` still reports **“requires Pi running inside Herdr”** after upgrading, Pi is running the old extension. Check for a standalone copy in `~/.pi/agent/extensions/`, move it outside that directory, install or update the package, and run `/reload` again.

## Use it

In interactive Pi, running inside a herdr-core terminal:

```text
/hfork
```

1. Choose **Current stage (latest)** or an earlier user message.
2. Enter a name for the side conversation.
3. Select the named fork in Moshi's workspace sidebar or the new herdr-app tab. You can also use `hc attach <terminal-name>`; the success notification prints the exact command.

The name becomes both the Pi session name and the workspace tab label. The new Pi process opens ready for your input; it does not automatically send a prompt. Escape cancels either dialog. An empty name also cancels.

```mermaid
flowchart LR
    A[Original Pi session] --> B[Run /hfork]
    B --> C[Choose a stage]
    C --> D[Enter a name]
    D --> E[Named workspace tab with its own Pi session]
    A --> F[Continue original work]
    E --> G[Continue side discussion]
```

## What gets copied?

The extension copies the selected prefix of the **active conversation branch** into a new session file, with a fresh ID and a link to the parent session.

| Selection | History in the new session |
| --- | --- |
| Current stage (latest) | The active branch captured when `/hfork` starts |
| An earlier user message | History through and including that message; later replies and messages are excluded |

For example, given this conversation:

```text
You: Design the API
Pi: Here is the design
You: Implement it
Pi: Implementation details
```

Selecting **Through user message: Implement it** copies the first three entries. The later implementation response is excluded. You can then type a new message in the side session. The selected message is already in its history; it is not placed back in the editor.

| Original session | Side session |
| --- | --- |
| Keeps its existing session file and active conversation | Gets a separate session file and Pi process |
| Can continue independently | Waits for your input in the new tab |
| Receives no automatic updates from the fork | Receives no later messages from the original |

Both sessions use the **same working directory and files**. This extension forks conversation history; it does not create a Git worktree, copy project files, or roll back file edits.

## Requirements and behavior

- Pi interactive terminal mode in a terminal managed by herdr-core (`HC_TERMINAL_ID` is set).
- herdr-core with `doc.get` and versioned `doc.set` support (verified with 0.1.19).
- `pi` and `hc` available on `PATH`; herdr-app is optional. Pi is resolved to an absolute executable path before launch so the core daemon's PATH does not need to contain it.
- A saved conversation with at least one entry; sessions started with `--no-session` cannot be forked.
- Pi session format version 3. The extension checks the version before writing a fork.

The extension starts a separate Pi terminal through `hc run --bg` with `--no-parent`, so the side conversation survives the original terminal closing. When herdr-app answers, the fork is labeled for the current terminal's space, adopted into a new tab, and named through `herdr-app do tab.rename` without changing focus.

When no local app answers, the extension uses `hc connect` to read and update the core-owned `herdr-app` document through `doc.get` / `doc.set`. It adds a named tab containing the new terminal to the source workspace. If there is no saved source workspace, it creates one containing the source and fork. Existing layout fields are preserved; only explicit version conflicts are retried against a fresh document. Accepted writes emit the document event Moshi watches. Terminal labels alone do not register a sidebar entry.

The original session is never switched or written to by the extension. The fork is stored next to its source session, including when you use a custom session directory. The legacy `herdr` CLI and `HERDR_ENV` / `HERDR_WORKSPACE_ID` variables are not used. Moshi can view the core remotely: herdr-app need not be installed or running on the host.

If a launch or registration fails, the error reports the fork path and any assigned terminal name and tab ID. A timeout can occur after a process has started or a layout write has been accepted, so inspect `hc get <reported-terminal-name> --json` and your workspace before retrying. Launches and renames are never automatically retried. A failed layout registration leaves the live fork available through `hc attach <reported-terminal-name>`.

`/hfork` creates a snapshot from recorded session entries. It does not duplicate an in-flight model request, tool execution, background job, or server.

## Update or remove

For the Git-source installation:

```bash
pi update --extensions
pi remove git:github.com/1am2syman/pi-herdr-session-fork
```

Run `/reload` afterward. For a local clone, use `git pull` inside the clone to update it. Removing the extension leaves previously created conversation files intact.

See [CHANGELOG.md](CHANGELOG.md) for release changes.

## Troubleshooting

**The fork runs but does not appear in Moshi.** After updating the extension, run `/reload` in the source Pi session. Headless forks must be registered in the core's workspace document; terminal labels alone are insufficient. No herdr-app window is needed. Inspect the reported terminal before creating another fork.

**`cannot start "pi": No such file or directory`.** Update and reload the extension. Version 0.2.0 resolves Pi before calling the daemon. If resolution itself fails, make sure `command -v pi` in your login shell returns an absolute executable path.

**The core reports an unsupported document method or layout.** Headless registration requires the core's `doc.get` / `doc.set` API and a compatible workspace document. The extension preserves an unsupported document and reports the terminal's recovery information. Inspect the fork before updating the core or retrying; it may already be running.

## Verification

Development requires Node.js 22.18+ and npm:

```bash
npm ci
npm test
npm run typecheck
```

The regression suite checks active-branch and earlier-stage history, unchanged source files, cancellation, literal shell characters in names, app adoption, headless workspace registration, version conflicts, preservation of concurrent edits and unknown layout fields, and recovery after failures. It uses simulated CLI responses and creates no real tabs.

With `hc` and `pi` installed, also run:

```bash
npm run test:core
```

This integration check starts real Pi processes in isolated herdr-core sessions with scratch config and state. It verifies app adoption (simulated app transport), headless registration in the real core document, arguments, source preservation, and independence from the source terminal, then cleans up. It does not change the user's core.

For an opt-in check against an active Moshi connection, close herdr-app and run the following from a terminal already visible in Moshi. Set `HFORK_MOSH_PORT` to that connection's Mosh server UDP port; `HFORK_GATEWAY_PORT` defaults to 24543.

```bash
HFORK_MOSH_PORT=60002 npm run test:moshi
```

This creates one temporary fork in the real core, requires it to appear under its name in Moshi's `/v1/workspaces` response with Pi live, checks the source terminal's PID is unchanged, then removes only the verification fork and its layout entry.

For a manual app check, run `/hfork` from a saved conversation in herdr-app. Confirm that the new tab appears in the source space with the requested name, focus stays where it was, and the fork is ready for input. Repeat with an earlier stage and cancel each dialog once.

Pi loads [extensions/herdr-fork.ts](extensions/herdr-fork.ts) directly; [extensions/core-layout.ts](extensions/core-layout.ts) handles the core document transport and registration. There is no build step.

## License

[MIT](LICENSE)
