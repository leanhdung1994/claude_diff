/**
 * diffStats.ts
 *
 * Line-level change counts between a snapshot and the current file, via the
 * Myers diff in the `diff` library (kpdecker/jsdiff). The diff itself is drawn
 * by VS Code's built-in diff editor; this only answers "does the file still
 * differ?" and feeds the `+N −M · K hunks` line in Pending Files.
 *
 * Callers pass LF-normalised text (`toLf()` in eol.ts), so an EOL-only change
 * counts as no change.
 */

import { diffArrays } from 'diff';

export interface DiffStats {
  /** Lines only in the current file. */
  additions: number;
  /** Lines only in the snapshot. */
  deletions: number;
  /** Contiguous blocks of changed lines; 0 means the contents are equal. */
  hunks: number;
}

export function computeDiffStats(originalContent: string, modifiedContent: string): DiffStats {
  // Split on /\r?\n/ rather than '\n' as a second line of defence: if a `\r`
  // stayed on every line, an EOL mismatch would make every line differ.
  const origLines = originalContent.split(/\r?\n/);
  const modLines = modifiedContent.split(/\r?\n/);

  // Content ending in a newline yields a trailing '' element. When both sides
  // have one it carries no information, but Myers may match it against a blank
  // line in the middle of the other side and cut one changed block in two.
  // Drop it only when both sides have it: on one side only, the final newline
  // itself was added or removed, which is a real change.
  if (origLines[origLines.length - 1] === '' && modLines[modLines.length - 1] === '') {
    origLines.pop();
    modLines.pop();
  }

  const stats: DiffStats = { additions: 0, deletions: 0, hunks: 0 };
  let inHunk = false;
  for (const change of diffArrays(origLines, modLines)) {
    if (change.added) {
      stats.additions += change.value.length;
    } else if (change.removed) {
      stats.deletions += change.value.length;
    } else {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      stats.hunks++;
      inHunk = true;
    }
  }
  return stats;
}
