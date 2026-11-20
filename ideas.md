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

    | Check                       | Command                                                                                                                                             | Result             |
    | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
    | Smart App Control           | `Get-MpComputerStatus \| Select SmartAppControlState`                                                                                               | Off                |
    | AppLocker                   | `Get-AppLockerPolicy -Effective -Xml`                                                                                                               | No rules           |
    | WDAC for user programs      | `Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard` → `UsermodeCodeIntegrityPolicyEnforcementStatus` | 0 (off)            |
    | Defender detections         | `Get-MpThreatDetection`                                                                                                                             | None for `hook.exe` |

  The benchmark also built `hook.exe` under `%TEMP%` and ran it 90 times with
  Defender real-time protection on, without anything stepping in. If Smart App
  Control were ever turned on, it would block the helper; the fallback to
  PowerShell covers that.
- **Legacy `csc.exe`: nothing to check ahead of time.** It ships with Windows
  but is no longer updated. The registry lookup, compile and test run happen
  when the mode is enabled, and any failure keeps the PowerShell hook.
- **Claude Code's launch overhead: answered.** Claude Code records hook
  timings in the transcript (`system` entries with subtype
  `stop_hook_summary` → `hookInfos[].durationMs`). For the current PowerShell
  hook across about 1,200 `Stop` runs: median about 350 ms (p90 about 440 ms)
  against 284 ms on its own, so Claude Code adds about 70 ms. Rare outliers
  reached 3.5 s.
  - **A hook with no `shell` key runs through Git Bash, but that's cheap.**
    Tested 2026-11-20 with Claude Code CLI 2.1.318 (headless `claude -p` in a
    scratch folder, test hook in that folder's `.claude/settings.local.json`).
    A probe exe logged its process ancestry as
    `probe.exe <- bash.exe <- bash.exe <- claude.exe`, with `MSYSTEM=UCRT64`
    and `SHELL=C:\Program Files\Git\bin\bash.exe`. Then the plain `hook.exe`
    ran as a second `Stop` hook for three turns:

      | Hook                                     | `durationMs` inside Claude Code |
      | ---------------------------------------- | ------------------------------- |
      | Current PowerShell hook                  | 323, 346, 331                   |
      | `hook.exe`, no `shell` key (via Git Bash) | 117, 116, 113                   |

    Outside Claude: `hook.exe` 42 ms directly, 81 ms through `bash -c`. So
    the 115 ms is about 40 ms helper + 40 ms Git Bash + 35 ms Claude Code.
    The real saving is **about 220 ms per hook run**. Bash can't be skipped
    (`shell: "powershell"` would bring PowerShell's startup back), so about
    115 ms is the floor for any hook here. On a machine without Git for
    Windows, Claude Code would use a different shell, so the wrapper cost
    would differ.

**Verdict (2026-11-20): don't build it now.** The helper works and the risks
are covered, but the saving is small at real usage. Over 30 days, turns that
made Edit/Write/Bash calls made a median of 2 such calls (p90 7), and
`PostToolUse` took a median 0.4% of turn time (p90 3.6%). About 220 ms per
call adds up to roughly 4 minutes a month, plus about the same for the turn
hooks. Revisit if turns get much more tool-heavy.

**Side finding (fixed 2026-11-20).** `~/.claude/settings.json` still had
`Stop` and `UserPromptSubmit` hooks writing to
`~/.ai-cli-diff-view/claude-events`, left over from the extension's old name.
The installer only manages entries containing `claude-diff` and
`claude-events`, so it never removed them, and each cost about 350 ms per
turn start and end. They and the `~/.ai-cli-diff-view/` folder were removed by
hand (backup: `~/.claude/settings.json.before-stale-hook-removal.bak`).

**Related.** This complements the transcript-claims idea, which reads `tool_use`
entries from the session transcript (`transcript_path` in the hook payload) so
no per-edit hook is needed. Combined: transcript claims for edits, helper for
the two turn-boundary hooks.

Benchmark and probe scripts (`bench/hook.cs`, `bench/bench.js`,
`probe/probe.cs`, `probe/bashcost.js`): the scratchpad of session `fed25485`,
which may be cleared. The C# source is the 15-line stdin-to-file copy described
above.

## Fourth attribution mode: transcript claims

**Problem.** Per-file mode learns which files Claude edited from a `PostToolUse`
hook: one process per Edit/Write/Bash call (about 0.23 s on Windows), plus event
files that can be several MB because they include `tool_response`. Turn mode is
cheap but counts every write during a turn (Quarto output, formatters).

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
  `sessionId` plus an `agentId`. That's cleaner than `PostToolUse`, where a
  subagent's own id forces claiming in every open turn.
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
