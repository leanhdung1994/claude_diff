# Ideas

## Native hook helper on Windows (faster per-file mode)

**Problem.** In `claudeCodeHooksPerFile`, every Edit/Write/Bash call fires a
`PostToolUse` hook. On Windows the hook is a PowerShell one-liner
(`claudeHookInstaller.ts`, `hookCommand`) that copies stdin to
`~/.claude-diff/claude-events/<guid>.json`. Almost all of its cost is PowerShell
startup, not the work.

**Idea.** Replace the one-liner with a tiny compiled helper that does the same
job: copy the stdin bytes to a temp file, then rename it to `<guid>.json`, print
nothing, always exit 0.

**Measured** (15 runs each, payload piped to stdin, 2026-11-20):

  | Hook                          | Small payload | 2 MB payload |
  | ----------------------------- | ------------- | ------------ |
  | `powershell.exe` (current)    | 284 ms        | 308 ms       |
  | Compiled C# helper (4 KB exe) | 48 ms         | 45 ms        |
  | `node` (reference)            | 68 ms         | 72 ms        |

That's about 0.24 s saved per tool call (about 7 s over a 30-call turn). The
`UserPromptSubmit`/`Stop` hooks get the same saving. Non-ASCII payloads were
kept byte for byte.

**How to get the helper (preferred).** Compile it on the user's machine with the
built-in .NET Framework 4 compiler (`csc.exe`, part of Windows 10/11) into
`~/.claude-diff/bin/hook.exe`. The VSIX ships only about 15 lines of C# source,
so there is no binary in the package and no native module.

**Finding `csc.exe`.** Look the path up; don't hard-code it. The Framework
records its install folder in the registry, and `csc.exe` sits in that folder:

```ts
// e.g. C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
const out = execFileSync('reg', ['query',
  'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full',
  '/v', 'InstallPath', '/reg:64'], { encoding: 'utf8' });
const dir = /InstallPath\s+REG_SZ\s+(.+)/.exec(out)?.[1].trim();
const csc = dir && path.join(dir, 'csc.exe');
```

- Node can't read the registry directly, so this calls `reg.exe` once, at
  compile time only.
- `/reg:64` reads the 64-bit view, so you get the `Framework64` compiler.
- If the lookup fails or `csc.exe` isn't there, keep the PowerShell hook.

**Rules:**

- Find the compiler, compile, and test-run the helper on a sample payload
  *before* writing its path into `settings.json`. If any step fails, keep the
  PowerShell hook.
- Use a stable path outside the versioned extension folder, so `settings.json`
  changes only when the helper first appears or disappears.
- Keep `claude-diff` and `claude-events` in the command, so the ownership check
  (`isOurs`) and uninstall cleanup still work. Uninstall already removes
  `~/.claude-diff/`.

**Risks and open questions** (checked on this machine, 2026-11-20):

- **Security software blocking the unsigned helper: not an issue here.**

  | Check                       | Command                                                                                                                                             | Result              |
  | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------  |
  | Smart App Control           | `Get-MpComputerStatus \| Select SmartAppControlState`                                                                                               | Off                 |
  | AppLocker                   | `Get-AppLockerPolicy -Effective -Xml`                                                                                                               | No rules            |
  | WDAC for user programs      | `Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard` → `UsermodeCodeIntegrityPolicyEnforcementStatus`       | 0 (off)             |
  | Defender detections         | `Get-MpThreatDetection`                                                                                                                             | None for `hook.exe` |

  The benchmark also built `hook.exe` under `%TEMP%` and ran it 90 times with
  Defender real-time protection on, without anything stepping in. If Smart App
  Control were ever turned on, it would block the helper; the fallback to
  PowerShell covers that.

- **Legacy `csc.exe`: nothing to check ahead of time.** It ships with Windows
  but is no longer updated. The registry lookup, compile and test run happen
  when the mode is enabled, and any failure keeps the PowerShell hook.

- **Claude Code's launch overhead: answered.** Claude Code records hook timings
  in the transcript (`system` entries with subtype `stop_hook_summary` →
  `hookInfos[].durationMs`). For the current PowerShell hook across about 1,200
  `Stop` runs: median about 350 ms (p90 about 440 ms) against 284 ms on its own,
  so Claude Code adds about 70 ms. Rare outliers reached 3.5 s.
  - **A hook with no `shell` key runs through Git Bash, but that's cheap.**
    Tested 2026-11-20 with Claude Code CLI 2.1.318 (headless `claude -p` in a
    scratch folder, test hook in that folder's `.claude/settings.local.json`). A
    probe exe logged its process ancestry as
    `probe.exe <- bash.exe <- bash.exe <- claude.exe`, with `MSYSTEM=UCRT64` and
    `SHELL=C:\Program Files\Git\bin\bash.exe`. Then the plain `hook.exe` ran as
    a second `Stop` hook for three turns:

    | Hook                                      | `durationMs` inside Claude Code |
    | ----------------------------------------  | ------------------------------- |
    | Current PowerShell hook                   | 323, 346, 331                   |
    | `hook.exe`, no `shell` key (via Git Bash) | 117, 116, 113                   |

    Outside Claude: `hook.exe` 42 ms directly, 81 ms through `bash -c`. So the
    115 ms is about 40 ms helper + 40 ms Git Bash + 35 ms Claude Code. The real
    saving is **about 220 ms per hook run**. Bash can't be skipped
    (`shell: "powershell"` would bring PowerShell's startup back), so about 115
    ms is the floor for any hook here. On a machine without Git for Windows,
    Claude Code would use a different shell, so the wrapper cost would differ.

**Verdict (2026-11-20): don't build it now.** The helper works and the risks are
covered, but the saving is small at real usage. Over 30 days, turns that made
Edit/Write/Bash calls made a median of 2 such calls (p90 7), and `PostToolUse`
took a median 0.4% of turn time (p90 3.6%). About 220 ms per call adds up to
roughly 4 minutes a month, plus about the same for the turn hooks. Revisit if
turns get much more tool-heavy.

**Side finding (fixed 2026-11-20).** `~/.claude/settings.json` still had `Stop`
and `UserPromptSubmit` hooks writing to `~/.ai-cli-diff-view/claude-events`,
left over from the extension's old name. The installer only manages entries
containing `claude-diff` and `claude-events`, so it never removed them, and each
cost about 350 ms per turn start and end. They and the `~/.ai-cli-diff-view/`
folder were removed by hand (backup:
`~/.claude/settings.json.before-stale-hook-removal.bak`).

**Related.** This complements the transcript-claims idea, which reads `tool_use`
entries from the session transcript (`transcript_path` in the hook payload) so
no per-edit hook is needed. Combined: transcript claims for edits, helper for
the two turn-boundary hooks.

Benchmark scripts (`bench/hook.cs`, `bench/bench.js`): the scratchpad of session
`fed25485`, which may be cleared. The C# source is the 15-line stdin-to-file
copy described above.

## Fourth attribution mode: transcript claims

**Problem.** Per-file mode learns which files Claude edited from a `PostToolUse`
hook: one process per Edit/Write/Bash call (about 0.33 s inside Claude Code on
Windows), plus event files that include `tool_response`. Turn mode is cheap but
counts every write during a turn (Quarto output, formatters).

**Idea.** A new `editAttribution` value (for example
`claudeCodeHooksTranscript`). Keep turn mode's two hooks (`UserPromptSubmit`,
`Stop`), drop `PostToolUse`, and read file claims from the session transcript
that Claude Code already writes.

**What the transcript has** (checked on Claude Code 2.1.328, 2026-11-20):

- Path: `~/.claude/projects/<cwd, non-alphanumerics → '-'>/<sessionId>.jsonl`.
  Every hook payload also includes `transcript_path`.
- Each edit appears as an `assistant` entry with a `tool_use` block: `name`,
  `input.file_path` (`notebook_path` for NotebookEdit), `sessionId`, `cwd`,
  `timestamp`. A later `user` entry carries the `tool_result`, with
  `toolUseResult.filePath`.
- Timing in one sample: `tool_use` logged at 48.542 s, file written at 48.799 s,
  `tool_result` logged at 49.572 s. So the claim can land *before* the write.
  `PostToolUse` always arrives after it.
- Subagents log to `<sessionId>/subagents/agent-*.jsonl`, with the parent's
  `sessionId` plus an `agentId`. (`PostToolUse` turned out to do the same; see
  the verdict below.)
- Bash `tool_use` entries carry only the command text, so the per-file Bash gap
  is unchanged.
- No turn-end marker (only `stop_hook_summary`, which exists only because a
  `Stop` hook ran), so the turn hooks are still needed.

**How it would work:**

1. On `UserPromptSubmit`, start tailing its `transcript_path` and the
   `subagents/` folder: `fs.watch` plus a poll, reading from a saved byte offset
   and keeping a partial last line until it's complete.
2. Each new Edit/Write/MultiEdit/NotebookEdit `tool_use` claims its file in that
   session's turn. A `Bash` `tool_use` sets the turn's "ran Bash" flag.
3. On `Stop`, read to the end of the transcript, then decide, then stop tailing.
4. Everything after a claim reuses per-file mode unchanged: `classifyWrite`, the
   `later` verdict, `decideHeldWrites`, `takeEarliestAgentWrite`.
5. Fallback: if the transcript is missing, can't be read, or yields no claims in
   a turn that had writes, use the turn window. That's the same fallback as for
   a session that never sent a `PostToolUse`.

**Compared with the existing hook modes:**

  | Aspect               | Turn window   | Transcript claims             | Per-file              |
  | -------------------  | ------------- | -----------------             | --------------------- |
  | Hook runs            | 2 per turn    | 2 per turn                    | 2 + 1 per tool call   |
  | Other programs       | count ❌      | ignored ✅                    | ignored ✅            |
  | Claim latency        | n/a           | about at the write, or before | ~0.3 s after          |
  | Documented interface | ✅            | ❌                            | ✅                    |

**Risks:**

- The transcript format is internal to Claude Code and could change without
  notice. The fallback limits the damage: the mode degrades to turn mode instead
  of dropping edits. Log the transcript's `version` when claims stop parsing.
- A `tool_use` is logged before permission and execution, so a denied or failed
  Edit still claims its file. That's harmless: a claim with no write opens
  nothing.
- Some clients may not write a transcript (for example the Agent SDK with
  persistence off). Those turns fall back to the turn window.
- Transcripts can be large (7 MB seen). Tail from an offset; bound the startup
  catch-up.

**Shipping options:** a fourth setting value, or the same reader inside
`claudeCodeHooksPerFile` with `PostToolUse` as the fallback. The second keeps
the settings simpler but makes that mode's behaviour harder to explain.

**First step:** a transcript reader plus tests in `scripts/test-attribution.js`
against a captured sample transcript, then wire it into `ClaudeAttribution`.
Pairs with the native helper above, which would make the two remaining turn
hooks cheap too.

**Verdict (2026-11-20): don't build it.** Every Edit/Write/Bash call in the
transcripts of the last ~5 hours was matched against the hook's event files by
`tool_use_id` (Claude Code 2.1.328):

  | Question                                          | Result                                                                  |
  | ------------------------------------------------- | ----------------------------------------------------------------------  |
  | Does `PostToolUse` miss tool calls?               | No: 75 of 75 calls have their event                                     |
  | Event file sizes                                  | Edit median 32 KB (max 43 KB), Bash 13 KB, Write 3 KB                   |
  | Do subagents report their own session id?         | No: all 5 used the parent's `session_id` (plus `agent_id`/`agent_type`) |
  | Claim delay vs the transcript's `tool_use` entry  | median 0.56 s, p90 1.2 s                                                |

The plan's benefits mostly disappear:

- Removing the per-call hook saves about 6 min/month at real usage, the same
  order as the native helper.
- Event files are about 30 KB, not MB-sized.
- Subagent handling is already clean.
- Held diffs would open only about 0.5 s sooner.
- The hook missed nothing, so there's no reliability problem to fix.

What remains is the cost: a parser for an undocumented format that changes
between frequent releases, roughly 200–300 lines of tailing code, and unverified
on-disk timing (the `tool_use` timestamp is creation time, not necessarily when
the line was flushed).

## Codex CLI support (unified agent attribution)

**Problem.** The hook modes (`claudeCodeHooks`, `claudeCodeHooksPerFile`) only
recognise Claude Code turns. A Codex turn's edits are ignored as "not the
agent's" once a hook mode is on.

**Idea.** Install the same kind of hooks into Codex and feed both agents' events
into one attribution engine. Edits made through shell commands are out of scope
for Codex: only `apply_patch` edits count.

**Codex hook interface** (docs: <https://learn.chatgpt.com/docs/hooks>; input
schemas in `openai/codex`, `codex-rs/hooks/schema/generated`):

- User config: `~/.codex/hooks.json` (Windows:
  `%USERPROFILE%\.codex\hooks.json`). Shape:
  `{"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type": "command", "command", "timeout"}]}]}}`,
  the same nesting as Claude's `settings.json`. An optional top-level
  `description` is ignored. It merges with a `[hooks]` table in `config.toml`;
  both in one layer makes Codex warn at startup (this machine's `config.toml`
  has none).
- Events used: `UserPromptSubmit`, `Stop`, `PostToolUse`, plus `Interrupt`
  (fires when the user interrupts a main-thread turn; Claude has no equivalent).
- Matchers are regexes and only apply to tool events. For `apply_patch`, the
  matchers `Edit` and `Write` also match.
- Timeouts in seconds (default 600; `Interrupt` and `SessionEnd` max 3). Command
  hooks are synchronous by default, so `UserPromptSubmit` finishes before the
  model starts, which the turn window relies on.
- Plain stdout from `UserPromptSubmit` reaches the model, so the hook must print
  nothing (same rule as Claude).
- **Trust:** non-managed hooks are skipped until the user trusts them in
  `/hooks`. Trust is recorded against a hash of the hook definition, so any
  change to the command re-asks. `--dangerously-bypass-hook-trust` skips this
  for one invocation.
- Subagent hooks carry the parent's `session_id` (docs), like Claude's.

**Live probe** (2026-11-20, codex-cli 0.163.0, Windows): `codex exec` in a
scratch git repo with a project-level `.codex/hooks.json`, hooking
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`
(`matcher: "*"`), `Stop` and `Interrupt` with a Node script that saved each
payload plus its process ancestry. Findings:

- **Every payload** has `session_id`, `turn_id`, `cwd`, `hook_event_name`,
  `transcript_path` (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), `model`
  and `permission_mode`. `UserPromptSubmit` has `turn_id` too.

- **Hooks run as** `pwsh.exe -NoProfile -Command "<command>"` (PowerShell 7,
  child of `codex.exe`). There is no `shell` field.

- **Nested tool calls are hooked.** This Codex runs tools in "code mode": the
  model calls a JavaScript `exec` tool whose code calls
  `tools.apply_patch("…")`. The hooks fire for the inner call with
  `tool_name: "apply_patch"`; no hook fires for the outer `exec`.

- **`apply_patch` payload:**

  ```json
  "tool_name": "apply_patch",
  "tool_input": { "command": "*** Begin Patch\n*** Update File: x.py\n@@\n-    retrun a + b\n+    return a + b\n*** End Patch" },
  "tool_response": "Exit code: 0\nWall time: 1.9 seconds\nOutput:\nSuccess. Updated the following files:\nM x.py\n"
  ```

  The patch path was relative to `cwd` here. Older sessions on this machine used
  absolute paths, with either `/` or `\`.

- **Shell commands** report as `tool_name: "Bash"`. `PostToolUse` did not fire
  when the sandbox failed to start the process
  (`CreateProcessAsUserW … Access is denied` in a folder under `%TEMP%`).

- **Timing:** `UserPromptSubmit` → edit ≈ 5 s → `PostToolUse` → `Stop` 3 s
  later. The turn was on record well before the write.

- Project-level hooks ran in an untrusted folder with the bypass flag.

- To rerun:
  `codex exec -C <dir> -m gpt-6-luna --sandbox workspace-write --dangerously-bypass-hook-trust --json "<prompt>"`.
  The model in `config.toml` (`gpt-6-sol`) is rejected for `codex exec` with
  this ChatGPT login. Put the file's content in the prompt; the sandbox couldn't
  run shell commands under `%TEMP%`.

**Claude vs Codex, for attribution:**

  | Need                | Claude Code                                                 | Codex                                                       |
  | ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
  | Config file         | `~/.claude/settings.json` (`hooks` key)                     | `~/.codex/hooks.json` (`hooks` key)                         |
  | Turn start / end    | `UserPromptSubmit` / `Stop`                                 | `UserPromptSubmit` / `Stop`                                 |
  | Interrupt           | none, and no `Stop` either                                  | `Interrupt` (`session_id`, `cwd`, `turn_id`)                |
  | Turn id             | none (`prompt_id` per user prompt)                          | `turn_id` on every event                                    |
  | Edited file         | `tool_input.file_path` / `notebook_path`, absolute          | parsed from the patch text, may be relative to `cwd`        |
  | Per-file matcher    | `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash`                | `apply_patch`                                               |
  | Windows hook shell  | `shell: "powershell"` (Git Bash without it)                 | always `pwsh -NoProfile -Command`                           |
  | Hook approval       | workspace trust dialog                                      | `/hooks` review, again after any change                     |

**What already fits** (no agent-specific logic):

- `WorkspaceWatcher` and the `EditAttribution` interface: untouched.
- `parseHookEvent` reads `hook_event_name`, `session_id`, `cwd`: same names.
- `ClaudeAttribution`: turn windows, `cwd` ↔ workspace matching, missed-turn
  recovery, `later` / `decideHeldWrites`.
- `ClaudeHookSource` takes its events folder as a constructor argument.
- `computeHookSettings` works on the `hooks` object, which has the same shape in
  both files.

**Changes needed:**

1. **Events folder per agent.** Write Codex events to
   `~/.claude-diff/codex-events/` and run a second `ClaudeHookSource` feeding
   the same attribution. Ownership marker for Codex entries: `claude-diff` +
   `codex-events`. Uninstall already deletes `~/.claude-diff/`.
2. **Installer for `hooks.json`.** Generalise `computeHookSettings` over (file,
   marker, events, matcher). Codex adds no `shell` key: the existing PowerShell
   one-liner (no double quotes in it) should work as the `command`, since Codex
   wraps it in `pwsh -Command`. Verify that exact string. Only install when
   `~/.codex` exists. Keep the command byte-stable, because any change makes
   Codex ask for trust again.
3. **Claims from patches.** `HookEvent.filePath` → `filePaths: string[]`. For
   `tool_name === 'apply_patch'`, collect the paths after `*** Add File: `,
   `*** Update File: `, `*** Delete File: ` and `*** Move to: `, resolving
   relative ones against the payload's `cwd`. No `Bash` in the Codex matcher: it
   would run a hook for every shell command, and shell edits are out of scope.
   Codex shell writes during a turn are then held and dropped at `Stop` in
   per-file mode.
4. **`Interrupt`.** Treat it as a turn end. Guard: if Codex also sends `Stop`
   after an interrupt (not documented), the current code would see a `Stop` with
   no open turn and run missed-turn recovery for that session. Remember the
   turns closed by `Interrupt` (`turn_id`) and ignore their `Stop`. More
   generally, Codex events could be paired by `turn_id` instead of by session.
5. **Trust UX.** After installing, tell the user to open `/hooks` in Codex and
   trust the entries. `hasSeenAnyEvent()` is global, so the "no hook event
   received" warning never fires for an untrusted Codex hook once Claude events
   exist. Track it per source. A write can't be blamed on one agent, though.
6. **Setting and messages.** One `editAttribution` value for both agents is
   simplest. Keep the existing value names so saved settings still work, and
   reword the descriptions, the offer prompt (`offerClaudeCodeHooks`) and the
   notifications.
7. **Uninstall** (`src/uninstall.ts`): also remove the Codex entries from
   `hooks.json`.
8. **Tests:** Codex payload cases in `scripts/test-attribution.js` (relative and
   absolute patch paths, multi-file patch, `Move to`, `Interrupt` followed by
   `Stop`), and the `hooks.json` installer.

**Unification decisions to make:**

- Rename `ClaudeAttribution` / `ClaudeHookSource` / `claudeHookInstaller` to
  agent-neutral names, or keep the names and add a Codex adapter.
- Whether Claude's per-file mode should also stop counting Bash, so both agents
  follow the same rule.
- Whether hooks are installed for an agent only when its config folder exists,
  or behind a per-agent switch.

**Open questions (untested):**

- The trust flow for a user-level hook in the Codex TUI and the Codex VS Code
  extension (sessions on this machine come from both, originators `codex-tui`
  and `codex_vscode`).
- Whether a running Codex session reloads `hooks.json` or needs a restart.
- The real `Interrupt` payload, and whether `Stop` follows it.
- Hook cost: every Codex hook pays `pwsh` startup, which the native helper idea
  above can't avoid (Codex always launches `pwsh`). Not measured.

**Verdict (2026-11-20): feasible, not built.** The probe confirmed the payloads
carry everything both modes need, including for `apply_patch` nested in code
mode. Effort is mostly the installer generalisation, the patch-path parser and
the trust messaging.
