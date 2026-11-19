/**
 * claudeAttribution.ts
 *
 * Pure logic (no `vscode` import) that decides whether a filesystem write seen
 * by WorkspaceWatcher was made by Claude Code, using a TURN WINDOW:
 *
 *   every write between the user's message (`UserPromptSubmit` hook) and
 *   Claude's `Stop` hook (+ a grace period) is Claude's.
 *
 * Claude Code waits for `UserPromptSubmit` to finish before Claude starts
 * working, so the turn is on record long before Claude's first edit — the
 * watcher's decision ~200 ms after a write always finds it, even when the
 * change notice arrives late (network/sync drives).
 *
 * A turn only covers files in a workspace folder related to the turn's `cwd`
 * (same folder, inside it, or a parent of it), so a Claude session in another
 * project never claims writes here.
 *
 * Anything not covered is NOT Claude's: the watcher just refreshes its baseline
 * and opens no diff (copying a file into the folder, git, formatters, …).
 *
 * Assumptions (see CLAUDE.md, "Claude turn-window attribution"): nothing but
 * Claude writes workspace files during a Claude turn, and turns are not
 * interrupted with Esc (an interrupt fires no `Stop`).
 *
 * PER-FILE MODE (`perFile` option) narrows that inside a turn, using the
 * `PostToolUse` hook (Edit/Write/MultiEdit/NotebookEdit/Bash):
 *
 *   - a file named by a `PostToolUse` of the turn is Claude's ("claimed"),
 *     also for late change notices up to `claimGraceMs` after the turn ends;
 *   - once the turn ran Bash, every write of the turn is Claude's (a Bash
 *     command doesn't say which files it writes);
 *   - any other write of an open turn is undecided (`later`): the watcher keeps
 *     its before-image and asks again when a claim arrives or the turn ends;
 *   - when the turn ends unclaimed, the write is not Claude's — unless its
 *     session never sent a `PostToolUse` (it started before the hook was
 *     installed, or never edited anything), which falls back to the turn window.
 */

import * as path from 'path';

export type HookEventName = 'UserPromptSubmit' | 'Stop' | 'PostToolUse';

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEventName>(['UserPromptSubmit', 'Stop', 'PostToolUse']);

export interface HookEvent {
  event: HookEventName;
  sessionId?: string;
  /** Normalized working directory of the Claude session, when present. */
  cwd?: string;
  /** When the hook ran (event file mtime), ms since epoch. */
  at: number;
  /** `PostToolUse` only: the tool that ran. */
  toolName?: string;
  /** `PostToolUse` only: normalized path of the file the tool edited, if it names one. */
  filePath?: string;
}

/** Verdict on one write: Claude's, not Claude's, or not decidable yet (per-file mode). */
export type WriteVerdict = 'claude' | 'notClaude' | 'later';

export interface AttributionTimings {
  /** Writes noticed up to this long after `Stop` still count (watcher latency). */
  stopGraceMs: number;
  /** Lifetime of a turn whose `Stop` never arrives (crash, window closed mid-turn). */
  maxOpenMs: number;
  /** Per-file mode: a claimed file's writes still count this long after its turn ends (late notices). */
  claimGraceMs: number;
}

export const DEFAULT_TIMINGS: AttributionTimings = {
  stopGraceMs: 10_000,
  maxOpenMs: 3 * 60 * 60_000,
  claimGraceMs: 60_000,
};

/** A `Stop` arrived for a session with no open turn (its turn-start hook failed). */
export interface StopWithoutStartInfo {
  sessionId?: string;
  cwd?: string;
  at: number;
  /** That session's previous `Stop`, if seen: the missing turn started after it. */
  since?: number;
}

export interface ClaudeAttributionOptions {
  /** Missing fields take DEFAULT_TIMINGS. */
  timings?: Partial<AttributionTimings>;
  /** Normalized workspace folder roots (as VS Code reports them). */
  workspaceFolders?: () => string[];
  /**
   * Resolves a path to a canonical form before comparing a turn's `cwd` with a
   * workspace folder (e.g. realpath, so `P:\x` and `\\server\share\x` match).
   * Results are cached per path. Default: identity.
   */
  canonicalize?: (p: string) => string;
  onStopWithoutStart?: (info: StopWithoutStartInfo) => void;
  /** A turn's `cwd` shares no workspace folder with a written file. */
  onCwdMismatch?: (cwd: string, root: string) => void;
  /** Per-file mode on? Read on every decision, so the setting can change at runtime. */
  perFile?: () => boolean;
  /**
   * Verdicts may have changed: a file was claimed, a turn ran Bash, or a turn
   * ended. Writes held as `later` should be classified again.
   */
  onDecisionsChanged?: () => void;
}

export function normalizeFsPath(p: string, platform: string = process.platform): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True if `child` is `parent` or inside it. Both must already be normalized. */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) { return true; }
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** Parse one raw hook payload (Claude Code hook stdin JSON). Returns undefined if unusable. */
export function parseHookEvent(raw: string, at: number): HookEvent | undefined {
  let obj: Record<string, unknown>;
  try {
    // PowerShell writers may prepend a BOM.
    obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') { return undefined; }

  const event = obj['hook_event_name'];
  if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) { return undefined; }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const cwd = str(obj['cwd']);

  const parsed: HookEvent = {
    event: event as HookEventName,
    sessionId: str(obj['session_id']),
    cwd: cwd ? normalizeFsPath(cwd) : undefined,
    at,
  };
  if (event === 'PostToolUse') {
    parsed.toolName = str(obj['tool_name']);
    const input = obj['tool_input'];
    if (input && typeof input === 'object') {
      const i = input as Record<string, unknown>;
      // NotebookEdit names its file `notebook_path`; the other tools `file_path`.
      const file = str(i['file_path']) ?? str(i['notebook_path']);
      if (file && path.isAbsolute(file)) { parsed.filePath = normalizeFsPath(file); }
    }
  }
  return parsed;
}

interface Turn {
  sessionId?: string;
  cwd?: string;
  start: number;
  end?: number;
  /** Per-file mode: canonical paths named by this turn's `PostToolUse` events. */
  claimed: Set<string>;
  /** Per-file mode: a `PostToolUse` for Bash arrived during this turn. */
  ranBash: boolean;
}

/** Closed turns are kept this long past their window for delayed watcher decisions. */
const PRUNE_MARGIN_MS = 60_000;

export class ClaudeAttribution {
  readonly timings: AttributionTimings;
  private readonly turns: Turn[] = [];
  /** Last `Stop` time per session — bounds the recovery window of a missed turn start. */
  private readonly lastStopAt = new Map<string, number>();
  /** Sessions that sent a `PostToolUse`, i.e. are known to run the per-file hook. */
  private readonly postToolSessions = new Set<string>();
  private readonly canonCache = new Map<string, string>();
  private everSawEvent = false;

  private readonly workspaceFolders: () => string[];
  private readonly canonicalize: (p: string) => string;
  private readonly onStopWithoutStart: (info: StopWithoutStartInfo) => void;
  private readonly onCwdMismatch: (cwd: string, root: string) => void;
  private readonly perFile: () => boolean;
  private readonly onDecisionsChanged: () => void;

  constructor(options: ClaudeAttributionOptions = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.workspaceFolders = options.workspaceFolders ?? (() => []);
    this.canonicalize = options.canonicalize ?? (p => p);
    this.onStopWithoutStart = options.onStopWithoutStart ?? (() => {});
    this.onCwdMismatch = options.onCwdMismatch ?? (() => {});
    this.perFile = options.perFile ?? (() => false);
    this.onDecisionsChanged = options.onDecisionsChanged ?? (() => {});
  }

  hasSeenAnyEvent(): boolean {
    return this.everSawEvent;
  }

  /**
   * @param historical the event happened before this window started (startup
   *        catch-up): record it, but never report a missed turn start for it.
   */
  ingest(evt: HookEvent, historical = false): void {
    this.everSawEvent = true;

    if (evt.event === 'UserPromptSubmit') {
      // A still-open turn of this session missed its Stop (Esc): it ends here.
      const open = this.openTurns(evt.sessionId);
      for (const t of open) { t.end = Math.max(t.start, evt.at); }
      this.turns.push({ sessionId: evt.sessionId, cwd: evt.cwd, start: evt.at, claimed: new Set(), ranBash: false });
      if (open.length > 0) { this.onDecisionsChanged(); }
      return;
    }

    if (evt.event === 'PostToolUse') {
      if (evt.sessionId) { this.postToolSessions.add(evt.sessionId); }
      // No open turn for this session id: a subagent may report its own id, or
      // the turn-start hook failed. Claim in every open turn rather than drop
      // Claude's edit; a claim only ever covers the file it names.
      const own = this.openTurns(evt.sessionId);
      for (const t of own.length > 0 ? own : this.openTurns()) {
        if (evt.toolName === 'Bash') { t.ranBash = true; }
        if (evt.filePath) { t.claimed.add(this.canon(evt.filePath)); }
      }
      this.onDecisionsChanged();
      return;
    }

    // Stop
    const open = this.openTurns(evt.sessionId);
    const since = evt.sessionId ? this.lastStopAt.get(evt.sessionId) : undefined;
    if (evt.sessionId) { this.lastStopAt.set(evt.sessionId, evt.at); }
    if (open.length === 0) {
      if (!historical) {
        this.onStopWithoutStart({ sessionId: evt.sessionId, cwd: evt.cwd, at: evt.at, since });
      }
      return;
    }
    for (const t of open) { t.end = Math.max(t.start, evt.at); }
    this.onDecisionsChanged();
  }

  /**
   * Turn-window rule only (ignores per-file mode).
   * @param absPath absolute path of the written file (normalized here, so
   *                callers can pass any form)
   * @param writeAt when the watcher received the write event (ms)
   */
  isClaudeWrite(absPath: string, writeAt: number): boolean {
    return this.turnsCovering(absPath, writeAt).length > 0;
  }

  /**
   * The verdict for one write under the current mode. In turn-window mode
   * only `claude` / `notClaude`; per-file mode may answer `later` while the
   * turn that could still claim the file is open.
   */
  classifyWrite(absPath: string, writeAt: number): WriteVerdict {
    const covering = this.turnsCovering(absPath, writeAt);
    if (!this.perFile()) { return covering.length > 0 ? 'claude' : 'notClaude'; }

    const target = this.canon(normalizeFsPath(absPath));
    const claimed = this.turns.some(t =>
      t.claimed.has(target) && writeAt >= t.start && writeAt <= this.claimClosesAt(t) &&
      this.turnMatchesPath(t.cwd, absPath)
    );
    if (claimed) { return 'claude'; }
    if (covering.length === 0) { return 'notClaude'; }
    if (covering.some(t => t.ranBash)) { return 'claude'; }
    if (covering.some(t => t.end === undefined)) { return 'later'; }
    // Ended unclaimed. A session never seen running the PostToolUse hook may
    // simply not have it (started before the install): keep the turn window.
    if (covering.some(t => !t.sessionId || !this.postToolSessions.has(t.sessionId))) { return 'claude'; }
    return 'notClaude';
  }

  /** Workspace filter: does a turn running in `cwd` cover this file? */
  turnMatchesPath(cwd: string | undefined, absPath: string): boolean {
    if (!cwd) { return true; }
    const target = normalizeFsPath(absPath);
    const root = this.workspaceFolders().find(r => isInside(target, r));
    if (!root) { return true; } // no folder info: don't over-filter
    const ok = this.related(cwd, root);
    if (!ok) { this.onCwdMismatch(cwd, root); }
    return ok;
  }

  /** Is `cwd` related to any workspace folder (same, inside, or parent)? */
  cwdMatchesWorkspace(cwd: string | undefined): boolean {
    if (!cwd) { return true; }
    const roots = this.workspaceFolders();
    return roots.length === 0 || roots.some(r => this.related(cwd, r));
  }

  /** End turns open past `maxOpenMs`, and drop turns that can no longer match any future write. */
  prune(now: number): void {
    let expired = false;
    for (const t of this.turns) {
      if (t.end === undefined && now > t.start + this.timings.maxOpenMs) {
        t.end = t.start + this.timings.maxOpenMs;
        expired = true;
      }
    }
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      const lastUse = t.claimed.size > 0 ? this.claimClosesAt(t) : this.closesAt(t);
      if (now - lastUse > PRUNE_MARGIN_MS) { this.turns.splice(i, 1); }
    }
    for (const [sessionId, at] of this.lastStopAt) {
      if (now - at > this.timings.maxOpenMs + this.timings.stopGraceMs) { this.lastStopAt.delete(sessionId); }
    }
    // Writes held `later` in an expired turn can be decided now.
    if (expired) { this.onDecisionsChanged(); }
  }

  private turnsCovering(absPath: string, writeAt: number): Turn[] {
    return this.turns.filter(t =>
      writeAt >= t.start && writeAt <= this.closesAt(t) && this.turnMatchesPath(t.cwd, absPath)
    );
  }

  private closesAt(t: Turn): number {
    return (t.end ?? t.start + this.timings.maxOpenMs) + this.timings.stopGraceMs;
  }

  /** A claimed file's writes count until this (late change notices for Claude's own edits). */
  private claimClosesAt(t: Turn): number {
    return (t.end ?? t.start + this.timings.maxOpenMs) +
      Math.max(this.timings.stopGraceMs, this.timings.claimGraceMs);
  }

  private openTurns(sessionId?: string): Turn[] {
    return this.turns.filter(t => t.end === undefined && (!sessionId || t.sessionId === sessionId));
  }

  private related(cwd: string, root: string): boolean {
    const c = this.canon(cwd);
    const r = this.canon(root);
    return isInside(c, r) || isInside(r, c);
  }

  private canon(p: string): string {
    let v = this.canonCache.get(p);
    if (v === undefined) {
      let resolved = p;
      try { resolved = this.canonicalize(p); } catch { /* keep p */ }
      v = normalizeFsPath(resolved);
      this.canonCache.set(p, v);
    }
    return v;
  }
}
