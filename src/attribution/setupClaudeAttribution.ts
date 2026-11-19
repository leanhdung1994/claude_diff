/**
 * setupClaudeAttribution.ts
 *
 * VS Code glue for the "claudeCodeHooks" (turn window) and
 * "claudeCodeHooksPerFile" attribution modes:
 *  - installs/removes the hooks when the setting changes,
 *  - provides the EditAttribution gate used by WorkspaceWatcher,
 *  - watches the hook events folder while a mode is on, so a `Stop` whose turn
 *    start was never recorded is noticed when the turn ends, and the writes the
 *    gate ignored during that turn are recovered as diffs,
 *  - in per-file mode, asks the watcher to classify its held writes again
 *    whenever a claim, a Bash run or a turn end may have decided them,
 *  - warns once if writes are being ignored while no hook event ever arrived
 *    (hook not installed, or a Claude session started before the install).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeAttribution, StopWithoutStartInfo, normalizeFsPath } from './claudeAttribution';
import { ClaudeHookSource } from './claudeHookSource';
import { AttributionHookMode, applyClaudeAttributionHooks, getClaudeSettingsPath } from './claudeHookInstaller';
import type { AgentWriteVerdict, EditAttribution } from '../watcher/workspaceWatcher';
import type { WriteVerdict } from './claudeAttribution';

const SECTION = 'claude-diff';
const MODE_KEY = 'editAttribution';
const POLL_INTERVAL_MS = 2000;
/** Coalesces the decisions-changed notices of one batch of hook events. */
const RECLASSIFY_DEBOUNCE_MS = 20;
type Mode = 'allExternalWrites' | 'claudeCodeHooks' | 'claudeCodeHooksPerFile';
type RecoveryHandler = (match: (absPath: string, eventAt: number) => boolean) => Promise<number>;
/** globalState: the user answered the one-time "only Claude's edits?" offer. */
const OFFER_ANSWERED_KEY = 'claude-diff.claudeCodeHooksOfferAnswered';

function getMode(): Mode {
  return vscode.workspace.getConfiguration(SECTION).get<Mode>(MODE_KEY, 'allExternalWrites');
}

function hookModeFor(mode: Mode): AttributionHookMode {
  switch (mode) {
    case 'claudeCodeHooks': return 'turn';
    case 'claudeCodeHooksPerFile': return 'perFile';
    default: return 'off';
  }
}

function toAgentVerdict(v: WriteVerdict): AgentWriteVerdict {
  return v === 'claude' ? 'agent' : v === 'later' ? 'later' : 'notAgent';
}

/** Canonical on-disk path, so a mapped drive and its UNC path compare equal. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Once per user, offer to switch from `allExternalWrites` (the default, which
 * changes nothing outside VS Code) to `claudeCodeHooks`. The hooks go into the
 * global ~/.claude/settings.json, so they are only installed with consent.
 *
 * Skipped when the user already chose a mode, and postponed while Claude Code
 * isn't set up yet (no ~/.claude folder). Closing the notification counts as
 * an answer; a notification left unanswered (VS Code closed first) asks again
 * next time. Choosing Enable changes the setting, and the setting's change
 * handler installs the hooks and explains the restart.
 */
export async function offerClaudeCodeHooks(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(OFFER_ANSWERED_KEY)) { return; }

  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<Mode>(MODE_KEY);
  if (inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined) {
    await context.globalState.update(OFFER_ANSWERED_KEY, true);
    return;
  }
  if (!fs.existsSync(path.dirname(getClaudeSettingsPath()))) { return; }

  const enable = 'Enable';
  const notNow = 'Not now';
  const choice = await vscode.window.showInformationMessage(
    'Diff Review for Claude Code opens a diff for every file written outside the editor, including by git, ' +
    'formatters or files you copy in. Only open diffs for Claude\'s edits? This adds two hooks to ' +
    '~/.claude/settings.json; you can change it later in Settings.',
    enable,
    notNow,
  );
  await context.globalState.update(OFFER_ANSWERED_KEY, true);
  if (choice === enable) {
    await vscode.workspace.getConfiguration(SECTION)
      .update(MODE_KEY, 'claudeCodeHooks', vscode.ConfigurationTarget.Global);
  }
}

export function setupClaudeEditAttribution(
  context: vscode.ExtensionContext,
  log: (msg: string) => void
): EditAttribution {
  let recover: RecoveryHandler | undefined;
  const loggedCwdMismatch = new Set<string>();
  const warnedRecoveredSessions = new Set<string>();

  const attribution: ClaudeAttribution = new ClaudeAttribution({
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map(f => normalizeFsPath(f.uri.fsPath)),
    canonicalize: realpathOrSelf,
    onCwdMismatch: (cwd, root) => {
      if (loggedCwdMismatch.has(cwd)) { return; }
      loggedCwdMismatch.add(cwd);
      log(`attribution: Claude turn cwd ${cwd} is unrelated to workspace folder ${root} — its turns don't cover files here`);
    },
    onStopWithoutStart: info => { void recoverMissedTurn(info); },
    perFile: () => getMode() === 'claudeCodeHooksPerFile',
    onDecisionsChanged: () => scheduleReclassify(),
  });
  const source = new ClaudeHookSource(attribution);
  let warnedNoEvents = false;

  /**
   * Per-file mode: writes held `later` may be decidable now. Open diffs for
   * those that count as Claude's; the rest stay remembered (still undecided,
   * or ignored for good). One run per batch of hook events.
   */
  let reclassifyTimer: NodeJS.Timeout | undefined;
  function scheduleReclassify(): void {
    if (getMode() !== 'claudeCodeHooksPerFile' || reclassifyTimer) { return; }
    reclassifyTimer = setTimeout(() => {
      reclassifyTimer = undefined;
      if (!recover) { return; }
      void recover((absPath, eventAt) => attribution.classifyWrite(absPath, eventAt) === 'claude')
        .then(opened => { if (opened > 0) { log(`attribution: opened ${opened} held write(s) now known to be Claude's`); } })
        .catch(() => {});
    }, RECLASSIFY_DEBOUNCE_MS);
  }
  context.subscriptions.push({ dispose: () => { if (reclassifyTimer) { clearTimeout(reclassifyTimer); } } });

  async function recoverMissedTurn(info: StopWithoutStartInfo): Promise<void> {
    if (!attribution.cwdMatchesWorkspace(info.cwd)) { return; } // another project's session
    const { maxOpenMs, stopGraceMs } = attribution.timings;
    const from = info.since ?? info.at - maxOpenMs;
    const to = info.at + stopGraceMs;
    const session = info.sessionId ?? 'unknown';
    log(`attribution: Stop without turn start (session ${session}) — recovering ignored writes ` +
      `${new Date(from).toISOString()} … ${new Date(to).toISOString()}`);
    if (!recover) { return; }
    const opened = await recover((absPath, eventAt) =>
      eventAt > from && eventAt <= to && attribution.turnMatchesPath(info.cwd, absPath)
    );
    log(`attribution: recovered ${opened} write(s) for session ${session}`);
    if (opened > 0 && !warnedRecoveredSessions.has(session)) {
      warnedRecoveredSessions.add(session);
      void vscode.window.showWarningMessage(
        'Diff Review for Claude Code: the Claude Code turn-start hook did not run for this turn, so its diffs opened ' +
        'only when Claude finished. If this repeats, restart the Claude session so it loads the hook.'
      );
    }
  }

  let poller: { dispose(): void } | undefined;
  const setPolling = (on: boolean) => {
    if (on && !poller) {
      poller = source.start(POLL_INTERVAL_MS);
    } else if (!on && poller) {
      poller.dispose();
      poller = undefined;
    }
  };
  context.subscriptions.push({ dispose: () => setPolling(false) });

  const sync = (announce: boolean) => {
    const mode = getMode();
    const hookMode = hookModeFor(mode);
    const enabled = hookMode !== 'off';
    const result = applyClaudeAttributionHooks(hookMode);
    log(`attribution:hooks ${hookMode} → ${result}`);
    setPolling(enabled);
    // Writes held under per-file mode are decided by the rule now in force
    // (the turn window opens the ones made during a turn).
    if (enabled && recover) {
      void recover((absPath, eventAt) => attribution.classifyWrite(absPath, eventAt) === 'claude').catch(() => {});
    }
    if (result === 'parseError') {
      void vscode.window.showErrorMessage(
        'Diff Review for Claude Code: ~/.claude/settings.json is not valid JSON, so the Claude Code hook was not ' +
        (enabled ? 'installed' : 'removed') + '. Fix the file and toggle the setting again.'
      );
    } else if (result === 'writeError') {
      void vscode.window.showErrorMessage('Diff Review for Claude Code: could not write ~/.claude/settings.json.');
    } else if (result === 'installed' && announce) {
      void vscode.window.showInformationMessage(
        hookMode === 'perFile'
          ? 'Diff Review for Claude Code: Claude Code hooks installed. Only files Claude edits (or writes during a ' +
            'turn that runs a command) will open diffs. Restart any Claude session that was already running so it ' +
            'picks up the hooks; until then its turns count every write.'
          : 'Diff Review for Claude Code: Claude Code hook installed. Only file changes made during a Claude turn will ' +
            'open diffs. Restart any Claude session that was already running so it picks up the hook.'
      );
    }
  };

  sync(false);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${SECTION}.${MODE_KEY}`)) { sync(true); }
    })
  );

  return {
    isEnabled: () => hookModeFor(getMode()) !== 'off',
    classifyWrite: async (absPath, eventAt) => toAgentVerdict(await source.classifyWrite(absPath, eventAt)),
    classifyWriteNow: (absPath, eventAt) => toAgentVerdict(attribution.classifyWrite(absPath, eventAt)),
    onUndecidedWrite: (absPath) => {
      log(`attribution:held write until Claude's tool events decide it ${absPath}`);
    },
    onIgnoredWrite: (absPath) => {
      log(`attribution:ignored non-Claude write ${absPath}`);
      if (!warnedNoEvents && !source.hasSeenAnyEvent()) {
        warnedNoEvents = true;
        void vscode.window.showWarningMessage(
          'Diff Review for Claude Code ignored a file change because no Claude turn was running, and no hook ' +
          'event has been received yet. If Claude made this change, restart the Claude session so it ' +
          'loads the hook.'
        );
      }
    },
    setRecoveryHandler: (handler) => { recover = handler; },
  };
}
