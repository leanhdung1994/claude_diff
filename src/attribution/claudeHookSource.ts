/**
 * claudeHookSource.ts
 *
 * Reads the event files the Claude Code hook drops into
 * ~/.claude-diff/claude-events/ and feeds them to ClaudeAttribution.
 *
 * Read on demand: WorkspaceWatcher asks right before deciding about a write
 * (≥200ms after the FS event). The `UserPromptSubmit` hook ran before Claude
 * started working, so the turn's start is always on disk by then.
 *
 * start() also reads new events as they arrive: an `fs.watch` on the folder
 * (it is under the home directory, not the workspace) plus a slow polling
 * timer as a backup. So a `Stop` without a turn start is noticed when the turn
 * ends, and in per-file mode a `PostToolUse` claim or a `Stop` decides held
 * writes within a fraction of a second instead of at the next write.
 *
 * Reads are serialized: two overlapping reads would both see the same new file
 * before either marks it as seen, and ingest it twice (a second `Stop` would
 * then look like a Stop without a turn start).
 *
 * The directory is shared by every VS Code window, so files are never consumed;
 * each window remembers what it has read and old files are deleted by age.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAttribution, WriteVerdict, parseHookEvent } from './claudeAttribution';
import { getClaudeEventsDir } from './claudeHookInstaller';

const FILE_MAX_AGE_MS = 30 * 60_000;
const CLEANUP_INTERVAL_MS = 60_000;
/** Coalesces the burst of fs.watch notifications one event file produces (tmp write + rename). */
const WATCH_DEBOUNCE_MS = 50;

export class ClaudeHookSource {
  private readonly seen = new Set<string>();
  private lastCleanup = 0;
  /** When this window started reading; older events are history (startup catch-up). */
  private readonly createdAt = Date.now();
  private chain: Promise<void> = Promise.resolve();
  private pendingReads = 0;

  constructor(
    private readonly attribution: ClaudeAttribution,
    private readonly eventsDir: string = getClaudeEventsDir()
  ) {}

  /** Turn-window verdict (ignores per-file mode). */
  async isClaudeWrite(absPath: string, writeAt: number): Promise<boolean> {
    await this.refresh();
    return this.attribution.isClaudeWrite(absPath, writeAt);
  }

  /** Verdict under the current mode, after reading any new events. */
  async classifyWrite(absPath: string, writeAt: number): Promise<WriteVerdict> {
    await this.refresh();
    return this.attribution.classifyWrite(absPath, writeAt);
  }

  hasSeenAnyEvent(): boolean {
    return this.attribution.hasSeenAnyEvent();
  }

  /** Read new event files. Calls are queued, never overlap. */
  refresh(): Promise<void> {
    this.pendingReads++;
    const run = this.chain.then(() => this.doRefresh());
    this.chain = run.catch(() => {}).then(() => { this.pendingReads--; });
    return run;
  }

  /**
   * Read new events as they arrive (fs.watch) and every `intervalMs` (backup:
   * fs.watch can miss events or fail, and the folder may not exist yet).
   */
  start(intervalMs = 2000): { dispose(): void } {
    let watcher: fs.FSWatcher | undefined;
    let debounce: NodeJS.Timeout | undefined;
    const kick = () => {
      if (this.pendingReads === 0) { void this.refresh().catch(() => {}); }
    };
    const onWatch = () => {
      if (debounce) { clearTimeout(debounce); }
      // Queue a read even if one is running: it may have listed the folder
      // before this file landed. Reads are serialized, so this is safe.
      debounce = setTimeout(() => { debounce = undefined; void this.refresh().catch(() => {}); }, WATCH_DEBOUNCE_MS);
    };
    const ensureWatcher = () => {
      if (watcher) { return; }
      try {
        watcher = fs.watch(this.eventsDir, onWatch);
        watcher.on('error', () => { watcher?.close(); watcher = undefined; });
      } catch {
        watcher = undefined; // folder missing: retried at the next poll
      }
    };
    ensureWatcher();
    const timer = setInterval(() => { ensureWatcher(); kick(); }, intervalMs);
    timer.unref?.();
    return {
      dispose: () => {
        clearInterval(timer);
        if (debounce) { clearTimeout(debounce); }
        watcher?.close();
        watcher = undefined;
      },
    };
  }

  private async doRefresh(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.eventsDir);
    } catch {
      return; // directory not created yet → hook never ran
    }

    const now = Date.now();
    const doCleanup = now - this.lastCleanup > CLEANUP_INTERVAL_MS;
    if (doCleanup) { this.lastCleanup = now; }

    const fresh: { name: string; at: number; raw: string }[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) { continue; } // skip in-flight .tmp files
      const full = path.join(this.eventsDir, name);
      if (this.seen.has(name)) {
        if (doCleanup) { await this.deleteIfOld(full, name, now); }
        continue;
      }
      try {
        const stat = await fs.promises.stat(full);
        // Catch up on the last FILE_MAX_AGE_MS at startup, so a turn that
        // started before this window opened is known when its Stop arrives.
        if (now - stat.mtimeMs > FILE_MAX_AGE_MS) {
          this.seen.add(name);
          if (doCleanup) { await this.deleteIfOld(full, name, now); }
          continue;
        }
        const raw = await fs.promises.readFile(full, 'utf8');
        fresh.push({ name, at: stat.mtimeMs, raw });
      } catch {
        // Deleted by another window or unreadable — retry next time.
      }
    }

    // A turn's start must be ingested before its Stop.
    fresh.sort((a, b) => a.at - b.at);
    for (const f of fresh) {
      this.seen.add(f.name);
      const evt = parseHookEvent(f.raw, f.at);
      if (evt) { this.attribution.ingest(evt, f.at < this.createdAt); }
    }
    this.attribution.prune(now);
  }

  private async deleteIfOld(full: string, name: string, now: number): Promise<void> {
    try {
      const stat = await fs.promises.stat(full);
      if (now - stat.mtimeMs > FILE_MAX_AGE_MS) {
        await fs.promises.unlink(full);
        this.seen.delete(name);
      }
    } catch {
      this.seen.delete(name);
    }
  }
}
