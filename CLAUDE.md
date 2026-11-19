# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What This Extension Does

Diff Review for Claude Code is a VS Code extension for reviewing Claude Code's
file edits inside VS Code. Edits are detected through the workspace watcher,
with no hooks required by default. The extension does not launch or host Claude
Code itself; it runs wherever the user likes (Claude Code extension, a terminal,
…).

## Commands

```bash
npm install
npm run compile      # tsc -p ./  → out/  (main build / correctness check)
npm run watch        # tsc -watch -p ./  (normal dev loop)
npx @vscode/vsce package   # runs vscode:prepublish = clean out/ + compile
```

- Press `F5` to launch the Extension Development Host (`.vscode/launch.json`),
  and reload the host after each recompile.
- There is no lint, formatter, or general test runner configured.
  `npm run compile` is the minimum correctness gate; `npm run test:attribution`
  runs the only automated tests (Claude hook attribution: turn window and
  per-file rule, hook installer, event source). Manually
  validate diff opening, accept/revert, and navigation in the Extension
  Development Host.
- `out/` is untracked and `tsc` never deletes files, so output from deleted
  modules lingers locally; `vscode:prepublish` runs `npm run clean` first so it
  is never packaged.
- The only runtime dependency is `diff`. There are no webview bundles or native
  modules.
- Strict TypeScript (`tsconfig.json`: `strict: true`, CommonJS, ES2020 target).
  2-space indentation, semicolons, single quotes; `PascalCase` for
  classes/providers, `camelCase` for functions/variables, `kebab-case` for asset
  filenames.

## Architecture

### Runtime shape

`src/extension.ts` is the entry point, activated `onStartupFinished` (and
`onFileSystem:claude-diff-original`, see below). It wires together the
`DiffManager`, the snapshot content provider, the workspace and git-branch
watchers, the navigation manager and the Pending Files view, then registers
commands.

The core responsibility: capture a before-image of a file, detect the
after-image once Claude writes it, then show it in VS Code's built-in diff
editor while keeping enough per-file state to accept or revert the whole file.

### Diff rendering — VS Code's built-in diff editor

- `DiffManager.openDiff` calls `vscode.diff(left, right, '<name> (AI changes)')`
  (`'<name> (new file, AI)'` for a file the agent created). The **right/modified
  side** is the real file (`file:` URI), so editing, saving, undo, language
  features and keybindings are VS Code's own.
- The **left/original side** is a read-only virtual document on the
  `claude-diff-original:` scheme (`src/diff/snapshotUri.ts`). The URI is the
  file URI with only the scheme swapped, so it keeps the file name and language.
  `SnapshotContentProvider` (`src/diff/snapshotContentProvider.ts`) serves
  `DiffManager.getSnapshot(uri.fsPath)` and fires `onDidChange` for every open
  snapshot document on each `onDidChangeDiffs`.
- Unchanged lines are collapsed through `contributes.configurationDefaults` →
  `diffEditor.hideUnchangedRegions.enabled: true`. That, inline vs side-by-side
  (`diffEditor.renderSideBySide`) and every other diff option are global user
  settings — there is no per-editor API.
- There is **no per-hunk accept/reject** (by design). Accept/revert work on
  whole files.
  - The diff editor's own "revert block" arrows still work: they edit the right
    side, and once the user saves content equal to the snapshot,
    `DiffManager.onDocumentSettled` drops the pending entry like an accept.
  - The agent can trigger this too (writing a file back to its original while
    you work elsewhere), so it never moves focus: a diff that is the visible tab
    of its group is replaced in place by the plain file with `preserveFocus`,
    and a background diff tab is just closed.
- **Tab recognition** — `isPendingDiffInput()`: a `TabInputTextDiff` whose
  `original.scheme` is the snapshot scheme. There is no panel registry;
  `findDiffTabs` / `closeDiffTabs` scan `vscode.window.tabGroups`.
- **Diff tabs survive a window reload.**
  - The `onFileSystem:claude-diff-original` activation event lets VS Code
    activate the extension to resolve a restored left side.
  - The provider is registered synchronously at the top of `activateExtension`.
  - `closeStaleDiffTabs()` closes restored tabs whose snapshot is gone.
  - `DiffManager.dispose()` therefore never closes tabs.
- **Closing a diff** — accept/revert/clearAll/acceptAllPending **open the plain
  text editor first, then close the diff tab** (`reopenAsTextEditor` →
  `closeDiffTabs`).
  - Why: closing the last editor of a document with unsaved edits would
    otherwise prompt save/discard.
  - `captureViewState()` records the diff tab's editor group, so with split
    editors the plain editor replaces the diff in its own group (even when its
    title-bar button was clicked in an inactive group).
  - It also records the cursor/scroll of the visible `file:` editor for that
    path in that group, i.e. the diff's right side.
- **Auto-routing** — if a pending file is opened as a plain text editor,
  `extension.ts` closes that tab and reopens it as its diff (`autoRouteTab`). A
  file whose snapshot was just removed is not rerouted, which is what lets
  `reopenAsTextEditor` work.
- **Stats** — `diffStats.ts` (`computeDiffStats`: Myers via the `diff` library,
  compared on LF-normalised text):
  - decides whether a file has any change at all (`openDiff` drops pure-EOL
    changes);
  - gives the `+/−/hunks` counts in Pending Files. A hunk is a contiguous block
    of changed lines, matching the change blocks the diff editor shows.

### Diff state model

`src/diff/diffManager.ts` is the center of the extension. It owns:

- the original-content snapshot map (left side of each diff), keyed by
  normalised path
- persistence via `src/diff/snapshotStore.ts` in workspace state under
  `claude-diff.snapshots` (survives VS Code restarts)
- the public `openDiff` / `accept` / `revert` / `acceptAllPending` / `clearAll`
  operations used by commands, the watchers and the Pending Files view
- the "edited back to original" cleanup (`onDocumentSettled`, only on saved /
  non-dirty content, skipped for paths in `resolving` so `revert()`'s own save
  doesn't trigger it)

Accept and revert are intentionally asymmetric:

- **Accept** just deletes the snapshot (the file on disk already holds the
  agent's version).
- **Revert** writes the snapshot back to disk (or deletes a file the agent
  created).
- After either, the next pending file's diff opens.

`clearAll()` (git branch change) reopens only the active diff as a plain editor.

- Problem: a checkout's writes open diffs asynchronously and race for the active
  tab.
- `WorkspaceWatcher.resolveOrHold` calls `markActiveTabBeforeAutoOpen()` on the
  first write of each cluster (writes more than 500 ms apart start a new one),
  recording the tab that was really active beforehand.
- `clearAll()` uses that hint instead of the current active tab if it is less
  than 15 s old. The hint is used once, then reset.

### Edit detection

Claude's edits are detected through the workspace watcher. By default
(`editAttribution = allExternalWrites`) every external write is treated as an
agent edit, whoever made it. The opt-in Claude hook modes below
(`claudeCodeHooks`, `claudeCodeHooksPerFile`) only *filter* the watcher's
writes; they are not a separate detection pipeline.

**Workspace watcher (the only path for agent edits)**

- **Watcher** — `src/watcher/workspaceWatcher.ts` combines save events with a
  `FileSystemWatcher` for any external write, regardless of which tool made it.
- **Baseline** — `src/watcher/baselineScanner.ts` builds the per-folder
  text-file baseline and `src/watcher/baselineStore.ts` stores it, so a newly
  written file is compared against prior content rather than treated as brand
  new.
- **Path exclusions** — `src/watcher/pathExclusions.ts` (`isExcludedPath`) is
  the single filter for untracked paths.
  - Shared by the scanner and the watcher. They must agree: a file the watcher
    processes without a baseline looks brand new, and Revert would delete it.
  - Checks only path components inside the workspace folder, case-insensitively.
    The file name itself counts as a component.
  - Excludes a fixed list of names, not all dot-folders (so `.github/` etc. are
    tracked):
    - dependency, build-output, VCS and tool-cache directories
    - editor/tool folders (`.vscode`, `.idea`, `.claude`)
    - `.env`
    - a `packages/` folder next to a `.sln` (legacy NuGet)
- **`create` vs `change` guard** — the watcher records which event a write came
  from.
  - A `change` to a file with no baseline proves the file existed: it only
    becomes the baseline and opens no diff…
  - …unless a `create` for that path was seen within 2 s (`recentCreates` /
    `wasCreatedAround`), since the `create` can lose the 500 ms debounce slot to
    its `change`.
  - A `create` with no baseline is still treated as a new file, because a
    write-to-temp-then-rename save also reports `create`.
- **Burst hold** — `src/watcher/writeBurstMeter.ts` decides whether a write is
  part of a burst (git checkout vs AI edits).
  - Writes past the burst threshold go into `WorkspaceWatcher`'s `heldWrites`
    queue for `burstDetectionHoldMs` instead of opening a diff immediately.
  - If `GitBranchWatcher` confirms a branch change in that window
    (`notifyExternalBatch()`), held writes are silently dropped; otherwise they
    open normally once the hold expires.
  - A held file that is written again stays held and keeps its **first**
    before-image (`resolveOrHold`). The watcher's baseline already contains the
    first write, so taking the before-image from it would hide that write and
    make Revert stop at the in-between version.
- **`notifyExternalBatch()`** — besides dropping held writes, it clears the
  in-memory baseline, rescans every folder, and starts a 5 s window in which
  external writes only refresh the baseline and open no diff.

### Claude turn-window attribution (opt-in, `editAttribution = claudeCodeHooks`)

`src/attribution/` decides whether an external write was Claude's, so files you
copy in, git, formatters etc. don't open diffs.

- **Hooks** — `claudeHookInstaller.ts` adds one `UserPromptSubmit` and one
  `Stop` hook to `~/.claude/settings.json` (plus `PostToolUse` in per-file
  mode; `computeHookSettings` takes the mode `off` / `turn` / `perFile`).
  - Timeout 30 s. The hook copies its stdin JSON into
    `~/.claude-diff/claude-events/`.
  - It must print nothing, because `UserPromptSubmit` stdout reaches Claude's
    context.
  - The installer owns only entries whose command contains both `claude-diff`
    and `claude-events`.
- **Rule** (`claudeAttribution.ts`, no `vscode` import):
  - A write is Claude's if
    `turn.start ≤ writeAt ≤ (turn.end ?? start + 3 h) + 10 s` for a turn whose
    `cwd` is the same as, inside, or a parent of the file's workspace folder.
  - Both sides are realpath'd, so a mapped drive matches its UNC path.
  - A new `UserPromptSubmit` closes the session's previous open turn.
- **Why turns, not per-edit events:**
  - The watcher overwrites its baseline *before* asking the gate, so a write
    wrongly judged "not Claude's" loses its before-image.
  - Claude Code waits for `UserPromptSubmit` before Claude starts, so the turn
    is always on record by the time the watcher decides (~200 ms after the
    write), even when the change notice is late.
- **Recovery:**
  - `WorkspaceWatcher` keeps the before-image of every ignored write
    (`ignoredWrites`).
  - If a `Stop` arrives for a session with no open turn (its turn-start hook
    failed), `setupClaudeAttribution.ts` asks the watcher to open diffs for that
    session's ignored writes since its previous `Stop`.
  - `ClaudeHookSource` polls the events folder every 2 s while the mode is on,
    so this happens when the turn ends. Its reads are serialized (overlapping
    reads would ingest one `Stop` twice), and it catches up on the last 30 min
    of events at startup.
- **Assumptions:**
  - Nothing but Claude writes workspace files during a Claude turn.
  - Turns are not interrupted with Esc (no `Stop` fires; the turn stays open
    until the next message or 3 h).

### Per-file attribution (opt-in, `editAttribution = claudeCodeHooksPerFile`)

Same hooks and turn window as above, plus one `PostToolUse` hook (matcher
`Edit|Write|MultiEdit|NotebookEdit|Bash`), so writes by other programs during a
turn (Quarto preview, formatters) don't open diffs.

- **Rule** (`ClaudeAttribution.classifyWrite`, verdict `claude` / `notClaude` /
  `later`). Outside every turn window: not Claude's. Inside one:
  - **Claimed** — the file was named by a `PostToolUse` of the turn
    (`file_path`, or `notebook_path` for NotebookEdit): Claude's. Claims also
    cover late change notices up to `claimGraceMs` (60 s) after the turn ends.
  - **Bash** — once the turn ran Bash, every write of that turn is Claude's (a
    command doesn't say which files it writes). Known gap: other programs'
    writes in such a turn count too.
  - Otherwise, while the turn is open: **`later`**.
  - Once the turn has ended unclaimed: not Claude's — unless its session has
    never sent a `PostToolUse` (started before the hook was installed, or
    hasn't edited anything yet), which falls back to the turn window rather
    than silently dropping its edits.
- **Holding** — a `later` write is stored in `ignoredWrites` like an ignored
  one (earliest before-image per file), logged as held.
  - `onDecisionsChanged` (on `PostToolUse`, `Stop`, a prompt closing an
    interrupted turn, a turn expiring at `maxOpenMs`) triggers
    `recoverIgnoredWrites` with "now Claude's" as the match. Debounced per batch
    of events.
  - When a new write is judged Claude's while an earlier write of the same file
    is still held, `takeEarliestAgentWrite` uses the earlier before-image, so
    the diff doesn't hide Claude's first edit.
  - Switching modes re-decides held writes under the rule now in force.
- **Latency** — `ClaudeHookSource.start()` `fs.watch`es the events folder
  (50 ms debounce, 2 s poll as backup), so a claim opens the held diff ~0.3 s
  after Claude's write.
- **Cost** — one hook run (~0.23 s on Windows) per Edit/Write/Bash call.
  `PostToolUse` payloads include `tool_response` (file contents, command
  output), so event files can be MB-sized; they are read once and deleted
  after 30 min.
- **Opt-in prompt** — `offerClaudeCodeHooks` (called at the end of activation)
  asks once per user whether to switch to this mode, because it edits the global
  `~/.claude/settings.json`.
  - Skipped if the user already set `editAttribution`; postponed while
    `~/.claude` doesn't exist.
  - Any answer (Enable, Not now, closing the notification) is recorded in
    `globalState` (`claude-diff.claudeCodeHooksOfferAnswered`).
  - Enable only updates the user setting; the setting's change handler installs
    the hooks.
- Tests: `npm run test:attribution` (compiles, then runs
  `scripts/test-attribution.js`, including the real hook command).

### Sound notifications (unrelated to diff detection)

- `src/commands/soundNotifications.ts` (`applySoundNotifications`) writes or
  removes `Notification`/`Stop` hook entries in `~/.claude/settings.json`
  (Windows only, via PowerShell `SoundPlayer`).
- `extension.ts` calls it whenever `claude-diff.soundNotificationsEnabled`
  changes.
- It only ever touches its own entries under those two keys: commands containing
  both `System.Media.SoundPlayer` and the trailing `# claude-diff` PowerShell
  comment. Any other hooks in the file are preserved, including the user's own
  SoundPlayer hooks.

### Uninstall cleanup

- `src/uninstall.ts` runs through the `vscode:uninstall` script after the
  extension is fully uninstalled (on the next VS Code restart).
- It runs in plain Node, so it must not import anything that imports `vscode`.
- It removes the attribution hooks, the sound hooks and `~/.claude-diff/`, and
  keeps the `settings.json.claude-diff.bak` backup.

### Git branch watcher

`src/watcher/gitBranchWatcher.ts` watches each workspace root's git state
(resolving `gitdir:` for worktrees/submodules) through two sources:

- **`.git/HEAD` content — branch changes**
  - On a HEAD ref change (branch switch / checkout / detached) it clears all
    pending diffs (`DiffManager.clearAll`), so stale snapshots aren't compared
    against a different branch's working tree.
  - It deliberately does **not** react to pull/rebase/reset on the same branch
    (those change `refs/heads/<branch>`, not HEAD's content), to avoid wiping
    pending state on every commit.
- **`.git/logs/HEAD` (reflog) — same-branch pull/merge/rebase/reset**
  - Tails the reflog and matches the action label git appends to the last line
    (`pull:`, `merge …`, `rebase (finish): …`, `reset: …`).
  - On a match it calls `workspaceWatcher.notifyExternalBatch()` (silently
    dropping burst-held writes and rebuilding the baseline) **without** clearing
    already-open pending diffs, which a same-branch pull/rebase/reset doesn't
    affect.
  - `commit`/`checkout` are excluded from the regex on purpose: commit shouldn't
    suppress anything, and checkout to another ref is already handled by the
    HEAD-content path.
- **Startup check** — each root's HEAD content is stored in workspace state
  (`claude-diff.lastHeadByFolder`). If HEAD differs at startup, the branch
  changed while VS Code was closed: the watcher calls `notifyExternalBatch()`
  and clears all pending diffs, as for a live branch change.

### UI composition

- **Diff tabs** — VS Code's diff editor. Title-bar buttons (`editor/title`,
  shown when `claude-diff.activeIsPendingDiff`): previous file, next file,
  revert file, accept file.
- **Pending Files view** — `src/views/pendingFilesPanel.ts`
  (`PendingFilesPanel`, view id `claude-diff.pendingFiles`) in the "Claude Diff"
  Activity Bar container.
  - A webview tree of pending files with icons from `media/file-icons/` and
    `+/−` counts from `DiffManager.getDiffPreviewMetadata()` (computed in the
    extension host; file contents never reach the webview).
  - Recounts on `onDidChangeDiffs` (a file became or stopped being pending).
  - Also recounts, 250 ms after the last one, on `onDidChangePendingContent` (an
    already-pending file's content changed). That event fires when:
    - `WorkspaceWatcher` skips a write to a pending file
      (`notifyPendingContentChanged()`; no document event fires if no editor has
      it open);
    - `onDocumentSettled` sees a saved/reloaded pending file that still differs
      from its snapshot.
  - Clicking a file calls `openDiff`.
  - View title buttons: Accept All Files (`acceptAllChanges`) and a gear
    (`openSettings`, opens Settings filtered to this extension).
- **Navigation** — `src/diff/navigationManager.ts`, reachable via the
  `prevFile`/`nextFile` commands, their `Alt+H`/`Alt+L` keybindings and the diff
  title-bar buttons.
- **Context keys** — `updatePendingContext` in `extension.ts` keeps two in sync
  via `DiffManager.onDidChangeDiffs` and tab-change events:
  - `claude-diff.hasPendingDiff` (any pending file)
  - `claude-diff.activeIsPendingDiff` (the active tab is a pending diff)

### Configurable text-file detection

`refreshTextFileRules()` / `isTextFile()` in `src/watcher/fileTypeRules.ts`
decide which files are reviewable. They read four settings (see below) and are
refreshed on the corresponding `onDidChangeConfiguration` events.
`supportedFileDetectionMode` chooses between built-in rules + custom, or
custom-only.

### Important implementation constraints

- **Path normalization is load-bearing.**
  - Paths go through `vscode.Uri.file(...).fsPath` and are lowercased on Windows
    before comparison.
  - `canonicalCasePath` (via `fs.realpathSync.native`) is used when calling VS
    Code APIs so tab titles show the on-disk case.
  - Snapshot URIs are built from the canonical-case file URI; the provider maps
    them back through `normalizePath`.
- Snapshot persistence is designed to survive restarts; changes to snapshot
  shape or cleanup affect restore logic (including restored diff tabs) as well
  as live diffing.
- Snapshots keep the file's original EOL; hunk comparisons are done on
  LF-normalised text (`src/diff/eol.ts`). Files are read and snapshots stored as
  UTF-8 strings, so Revert does not restore a file in another encoding byte for
  byte.

## Settings (contributed configuration)

  | Setting                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                              |
  | ---                                      | ---                                                                                                                                                                                                                                                                                                                                                                                                  |
  | `claude-diff.editAttribution`            | `allExternalWrites` (default: every external write is an agent edit) or `claudeCodeHooks` (Claude turn-window attribution; installs hooks in `~/.claude/settings.json`) or `claudeCodeHooksPerFile` (per-file attribution; adds a `PostToolUse` hook)                                                                                                                                                                                                                              |
  | `claude-diff.supportedFileDetectionMode` | `defaultAndCustom` (default) or `customOnly`                                                                                                                                                                                                                                                                                                                                                         |
  | `claude-diff.supportedFileExtensions`    | Extra extensions to treat as text (dot optional)                                                                                                                                                                                                                                                                                                                                                     |
  | `claude-diff.supportedFilenames`         | Extra exact filenames to treat as text                                                                                                                                                                                                                                                                                                                                                               |
  | `claude-diff.supportedFilenamePatterns`  | Extra basename globs (`*`, `?`) to treat as text                                                                                                                                                                                                                                                                                                                                                     |
  | `claude-diff.maxFileLines`               | Advanced: ignore files above this many lines — no baseline, no diff (default 5000; `0` disables). Enforced in `src/watcher/fileSizeLimit.ts`, applied by `baselineScanner` and both write paths in `workspaceWatcher`. Skipped files are recorded in `BaselineStore.sizeSkipped` so that one later dropping below the limit is not mistaken for a brand-new file (which would make Revert delete it) |
  | `claude-diff.baselineScanConcurrency`    | Advanced: maximum number of files read concurrently during the initial baseline scan (default 4, range 1–16). Lower it for large or remote workspaces to reduce I/O and memory pressure.                                                                                                                                                                                                             |
  | `claude-diff.burstDetectionEnabled`      | Advanced: hold files beyond the burst threshold to confirm a git branch change before opening their diff, instead of opening immediately (see "Workspace watcher" above)                                                                                                                                                                                                                             |
  | `claude-diff.burstDetectionWindowMs`     | Advanced: sliding window (ms) used to count file changes for burst detection (default 300)                                                                                                                                                                                                                                                                                                           |
  | `claude-diff.burstDetectionThreshold`    | Advanced: number of file-change events within the window that counts as a burst (default 8). `WriteBurstMeter.record()` counts every raw watcher event, so repeated writes to one file each count                                                                                                                                                                                                    |
  | `claude-diff.burstDetectionHoldMs`       | Advanced: how long (ms) to hold burst-threshold-exceeding files before opening their diff if no git branch change is confirmed (default 2000)                                                                                                                                                                                                                                                        |
  | `claude-diff.soundNotificationsEnabled`  | Play a sound when Claude finishes a turn or needs input (Windows only, default off) — unrelated to diff detection                                                                                                                                                                                                                                                                                    |

All of these are edited in VS Code's Settings UI (the Pending Files gear opens
it filtered to this extension). `contributes.configurationDefaults` also sets
`diffEditor.hideUnchangedRegions.enabled` to `true`. `.git/index`-based early
confirmation is a known gap — the burst hold relies solely on
`GitBranchWatcher`'s existing `HEAD`-change confirmation.

## Registered Commands and Keybindings

  | Command                        | Keybinding                                  | Purpose                                                                                                                |
  | ---                            | ---                                         | ---                                                                                                                    |
  | `claude-diff.acceptFile`       | `Ctrl+Shift+Y` (when `activeIsPendingDiff`) | Accept the pending diff in the active tab (or the one whose title-bar button was clicked); otherwise warn, never guess |
  | `claude-diff.revertFile`       | `Ctrl+Shift+Z` (when `activeIsPendingDiff`) | Revert the pending diff in the active tab (or the one whose title-bar button was clicked); otherwise warn, never guess |
  | `claude-diff.acceptAllChanges` | —                                           | Accept all pending changes across files                                                                                |
  | `claude-diff.openPendingFile`  | —                                           | Open a pending file's diff (takes a path arg)                                                                          |
  | `claude-diff.openSettings`     | —                                           | Open Settings filtered to this extension                                                                               |
  | `claude-diff.prevFile`         | `Alt+H` (when `hasPendingDiff`)             | Go to previous pending file                                                                                            |
  | `claude-diff.nextFile`         | `Alt+L` (when `hasPendingDiff`)             | Go to next pending file                                                                                                |
