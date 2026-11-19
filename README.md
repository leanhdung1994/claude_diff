# Diff Review for Claude Code

Review every file edit Claude Code makes in VS Code's built-in diff editor, then
accept or revert it.

No setup needed. Edits are detected from the file system, so Claude Code can run
anywhere: the Claude Code extension, VS Code's terminal or an external one.

## How it works

1. When Claude writes a file, a diff tab `<file> (AI changes)` opens: the
   original on the left, the live, editable file on the right.
2. **Accept** keeps Claude's version; **Revert** restores the original (or
   deletes the file if Claude created it). The next pending file opens
   automatically.
3. The **Pending Files** view (Claude Diff icon in the Activity Bar) lists every
   file awaiting review with `+/−` counts, plus **Accept All Files**.

Unchanged lines are collapsed, pending diffs survive VS Code restarts, and git
branch switches, pulls and rebases don't flood you with diffs.

## Commands and keybindings

  | Command                           | Keybinding                      |
  | --------------------------------- | ------------------------------- |
  | Claude Diff: Accept File          | `Ctrl+Shift+Y` (`Cmd` on macOS) |
  | Claude Diff: Revert File          | `Ctrl+Shift+Z` (`Cmd` on macOS) |
  | Claude Diff: Previous Edited File | `Alt+H`                         |
  | Claude Diff: Next Edited File     | `Alt+L`                         |
  | Claude Diff: Accept All Files     | —                               |
  | Claude Diff: Open Settings        | —                               |

Accept, revert and file navigation are also buttons in the diff tab's title bar.

## Settings

All under `claude-diff.*` (gear button in the Pending Files view). Key ones:

- `editAttribution`: `allExternalWrites` (default) opens a diff for any file
  written outside the editor. `claudeCodeHooks` only counts writes made during a
  Claude Code turn; it adds two hooks to `~/.claude/settings.json` (restart
  running Claude sessions afterwards). `claudeCodeHooksPerFile` only counts the
  files Claude edits with its file tools, so other programs writing during a
  turn (a Quarto preview, a formatter) are ignored. In a turn where Claude runs a
  shell command, every write of that turn still counts. It adds a third hook,
  which costs about 0.2 s per edit.
- `supportedFileExtensions` / `supportedFilenames` /
  `supportedFilenamePatterns`: extra files to review.
- `maxFileLines`: skip files longer than this (default 5000).
- `soundNotificationsEnabled`: sound when Claude finishes or needs input
  (Windows).

To show whole files, turn off `diffEditor.hideUnchangedRegions.enabled`; for
inline diffs, turn off `diffEditor.renderSideBySide`.

Uninstalling removes the extension's hooks and `~/.claude-diff` folder on the
next VS Code restart.

## Development

```bash
npm install
npm run compile            # or: npm run watch
npx @vscode/vsce package   # build a .vsix
```

Press `F5` to launch the Extension Development Host.

## Acknowledgements

This extension is a modified fork of
[claude_diff_view_vscode_extension](https://github.com/konan-1947/claude_diff_view_vscode_extension)
by konan-1947, licensed under AGPL-3.0. It was forked and modified in November
2026; see the git history for the changes.

## License

Copyright (C) konan-1947 (original work)\
Copyright (C) 2026 leanhdung1994 (modifications)

Licensed under the [GNU Affero General Public License v3.0](LICENSE).
