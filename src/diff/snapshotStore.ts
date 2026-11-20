/**
 * snapshotStore.ts
 *
 * Persistence layer cho diff snapshots: đọc/ghi `context.workspaceState`
 * dưới key `claude-diff.snapshots`.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { isExcludedPath } from '../watcher/pathExclusions';

const STATE_KEY = 'claude-diff.snapshots';

export interface SnapshotState {
  content: string;
  fileExistedBefore: boolean;
}

export class SnapshotStore {
  constructor(private readonly workspaceState: vscode.Memento) {}

  /**
   * Đọc snapshot đã persist trước đó. Bỏ qua entry mà file không còn tồn tại,
   * and entries for paths that are excluded now: a snapshot saved before a
   * folder joined the exclusion list (e.g. `.quarto/`) would otherwise stay
   * pending forever and pop up when Accept/Revert hands over to the next file.
   */
  load(): Map<string, SnapshotState> {
    const saved = this.workspaceState.get<Record<string, SnapshotState>>(STATE_KEY, {});
    const result = new Map<string, SnapshotState>();
    for (const [absPath, savedSnapshot] of Object.entries(saved)) {
      if (!fs.existsSync(absPath) || isExcludedPath(absPath)) { continue; }
      result.set(absPath, normalizeSavedSnapshot(savedSnapshot));
    }
    return result;
  }

  save(snapshots: Map<string, SnapshotState>): Thenable<void> {
    const obj: Record<string, SnapshotState> = {};
    for (const [absPath, snapshot] of snapshots.entries()) {
      obj[absPath] = snapshot;
    }
    return this.workspaceState.update(STATE_KEY, obj);
  }

  clear(): Thenable<void> {
    return this.workspaceState.update(STATE_KEY, undefined);
  }
}

function normalizeSavedSnapshot(savedSnapshot: SnapshotState): SnapshotState {
  return {
    content: savedSnapshot.content,
    fileExistedBefore: savedSnapshot.fileExistedBefore === false ? false : true,
  };
}
