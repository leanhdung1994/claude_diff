import * as vscode from 'vscode';
import { DiffManager } from './diff/diffManager';
import { SnapshotContentProvider } from './diff/snapshotContentProvider';
import { SNAPSHOT_SCHEME } from './diff/snapshotUri';
import { WorkspaceWatcher } from './watcher/workspaceWatcher';
import { refreshTextFileRules } from './watcher/fileTypeRules';
import { refreshPathExclusions } from './watcher/pathExclusions';
import { refreshFileSizeLimit } from './watcher/fileSizeLimit';
import { GitBranchWatcher } from './watcher/gitBranchWatcher';
import { registerAllCommands } from './commands/commandsRegistry';
import { applySoundNotifications } from './commands/soundNotifications';
import { NavigationManager } from './diff/navigationManager';
import { PendingFilesPanel } from './views/pendingFilesPanel';
import { offerClaudeCodeHooks, setupClaudeEditAttribution } from './attribution/setupClaudeAttribution';

const LOG_PREFIX = '[claude-diff]';

let diagnosticChannel: vscode.OutputChannel | undefined;

function debugLog(message: string): void {
  const line = `${LOG_PREFIX} ${new Date().toISOString()} ${message}`;
  console.log(line);
  diagnosticChannel?.appendLine(line);
}

function debugError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error ?? '');
  const line = `${LOG_PREFIX} ${new Date().toISOString()} ${message} ${detail}`;
  console.error(line, error ?? '');
  diagnosticChannel?.appendLine(line);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  diagnosticChannel = vscode.window.createOutputChannel('Diff Review for Claude Code');
  context.subscriptions.push(diagnosticChannel);

  try {
    await activateExtension(context);
  } catch (error: unknown) {
    debugError('activate:failed', error);
    void vscode.window.showErrorMessage(
      `Diff Review for Claude Code failed to activate: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  debugLog(`activate:start mode=${context.extensionMode} workspace=${vscode.workspace.workspaceFile?.fsPath ?? 'none'}`);

  refreshTextFileRules();
  refreshPathExclusions();
  refreshFileSizeLimit();
  debugLog('activate:configuration initialized');

  const diffManager       = new DiffManager(context);
  // Register the left-side provider first, before anything awaits: VS Code
  // may already be restoring diff tabs from the previous session.
  const snapshotProvider  = new SnapshotContentProvider(diffManager);
  context.subscriptions.push(
    snapshotProvider,
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotProvider),
  );
  const editAttribution   = setupClaudeEditAttribution(context, debugLog);
  const workspaceWatcher  = new WorkspaceWatcher(diffManager, editAttribution);
  const gitBranchWatcher  = new GitBranchWatcher(diffManager, context.workspaceState, workspaceWatcher);
  const navigationManager = new NavigationManager(diffManager);
  debugLog('activate:core services constructed');

  const pendingFilesPanel = new PendingFilesPanel(context.extensionUri, diffManager);
  context.subscriptions.push(
    pendingFilesPanel,
    vscode.window.registerWebviewViewProvider(PendingFilesPanel.viewType, pendingFilesPanel),
  );
  debugLog('activate:pending files view registered');

  context.subscriptions.push(
    diffManager,
    { dispose: () => workspaceWatcher.dispose() },
    { dispose: () => gitBranchWatcher.dispose() }
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-diff.supportedFileDetectionMode') ||
          e.affectsConfiguration('claude-diff.supportedFileExtensions') ||
          e.affectsConfiguration('claude-diff.supportedFilenames') ||
          e.affectsConfiguration('claude-diff.supportedFilenamePatterns')) {
        refreshTextFileRules();
        workspaceWatcher.rescanBaselines();
      }
      if (e.affectsConfiguration('claude-diff.excludedPaths')) {
        refreshPathExclusions();
        workspaceWatcher.rescanBaselines();
      }
      if (e.affectsConfiguration('claude-diff.maxFileLines')) {
        refreshFileSizeLimit();
      }
      if (e.affectsConfiguration('claude-diff.soundNotificationsEnabled')) {
        const enabled = vscode.workspace
          .getConfiguration('claude-diff')
          .get<boolean>('soundNotificationsEnabled', false);
        try {
          applySoundNotifications(enabled);
        } catch (error: unknown) {
          debugError('sound notifications: could not update ~/.claude/settings.json', error);
        }
      }
    })
  );

  workspaceWatcher.start();
  debugLog('activate:workspace watcher started');
  gitBranchWatcher.start();
  debugLog('activate:git branch watcher started');

  registerAllCommands({ diffManager, context });
  debugLog('activate:standard commands registered');

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-diff.nextFile', () => navigationManager.nextFile()),
    vscode.commands.registerCommand('claude-diff.prevFile', () => navigationManager.prevFile()),
    vscode.commands.registerCommand('claude-diff.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    )),
  );

  function updatePendingContext(): void {
    const hasPending = diffManager.getPendingFiles().length > 0;
    const activeDiff = diffManager.getActiveDiffPath();
    pendingFilesPanel.setActiveFile(activeDiff);
    void vscode.commands.executeCommand('setContext', 'claude-diff.hasPendingDiff', hasPending);
    // Gates the diff tab's title-bar buttons and the Ctrl+Shift+Y/Z keybindings.
    void vscode.commands.executeCommand('setContext', 'claude-diff.activeIsPendingDiff', activeDiff !== undefined);
  }

  context.subscriptions.push(
    diffManager.onDidChangeDiffs(() => updatePendingContext()),
    vscode.window.tabGroups.onDidChangeTabs(() => updatePendingContext()),
    // Focusing another editor group changes the active tab without changing
    // any tab, so onDidChangeTabs alone leaves activeIsPendingDiff stale.
    vscode.window.tabGroups.onDidChangeTabGroups(() => updatePendingContext()),
    vscode.window.onDidChangeActiveTextEditor(() => updatePendingContext()),
  );

  const autoRouteTab = (tab: vscode.Tab, event: 'opened' | 'changed'): void => {
    if (!(tab.input instanceof vscode.TabInputText)) { return; }
    // A tab becomes `changed` when the user edits it. Never close a dirty
    // document from the auto-router: doing so makes VS Code show its
    // save/discard confirmation and can discard edits before auto-save runs.
    if (tab.isDirty) { return; }
    const fsPath = tab.input.uri.fsPath;
    if (!diffManager.hasPendingDiff(fsPath)) { return; }
    // A newly opened tab is always routed (even one opened in the background,
    // or while the diff is still opening). A `changed` tab only when it is its
    // group's front tab and the file has no diff anywhere yet:
    // - openDiff() opens the diff in front of the text tab before closing
    //   it, which reports that tab as `changed`;
    // - openDiff() deliberately keeps a text tab that is the only tab of
    //   another group.
    // Routing those would pull focus to the diff on every save.
    if (event === 'changed' && (
      !tab.isActive || diffManager.isOpeningDiff(fsPath) || diffManager.hasDiffTab(fsPath)
    )) { return; }
    void (async () => {
      try {
        // openDiff() opens the diff in this tab's group, then closes the tab.
        await diffManager.openDiff(fsPath, { viewColumn: tab.group.viewColumn, preserveFocus: !tab.isActive });
      } catch (err) {
        console.error('[claude-diff] auto-route failed:', err);
      }
    })();
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) { autoRouteTab(tab, 'opened'); }
      for (const tab of e.changed) { autoRouteTab(tab, 'changed'); }
    })
  );

  // Restored text tabs of pending files, background ones included, become
  // their diffs without taking focus.
  void diffManager.routeRestoredTextTabs().catch((err: unknown) => {
    console.error('[claude-diff] startup auto-route failed:', err);
  });
  await diffManager.closeStaleDiffTabs();

  updatePendingContext();
  debugLog('activate:complete');

  // Not awaited: the notification can stay open for as long as the user likes.
  void offerClaudeCodeHooks(context).catch((error: unknown) => debugError('claudeCodeHooks offer failed', error));
}

export function deactivate(): void {
  // Nothing to do: every disposable is registered on context.subscriptions.
}
