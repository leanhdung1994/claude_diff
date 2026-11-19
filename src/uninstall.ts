/**
 * uninstall.ts
 *
 * Run by VS Code through `vscode:uninstall` (package.json) once the extension
 * is fully uninstalled, i.e. after the next VS Code restart. It runs in a
 * plain Node process: no `vscode` API, so only modules without a `vscode`
 * import may be used here.
 *
 * Removes what the extension put outside VS Code: its hook entries in
 * ~/.claude/settings.json (attribution and sound) and the hook events folder.
 * Without this, every Claude prompt in every project would keep running the
 * attribution hook after the extension is gone. The backup
 * settings.json.claude-diff.bak is kept on purpose.
 */

import * as fs from 'fs';
import * as path from 'path';
import { applyClaudeAttributionHooks, getClaudeEventsDir } from './attribution/claudeHookInstaller';
import { applySoundNotifications } from './commands/soundNotifications';

function step(label: string, fn: () => unknown): void {
  try {
    const result = fn();
    console.log(`[claude-diff] uninstall: ${label}${result === undefined ? '' : ` → ${String(result)}`}`);
  } catch (err) {
    console.error(`[claude-diff] uninstall: ${label} failed:`, err);
  }
}

step('remove attribution hooks', () => applyClaudeAttributionHooks('off'));
step('remove sound hooks', () => applySoundNotifications(false));
// ~/.claude-diff holds only the extension's hook event files.
step('remove events folder', () => fs.rmSync(path.dirname(getClaudeEventsDir()), { recursive: true, force: true }));
