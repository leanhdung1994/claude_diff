/**
 * claudeHookInstaller.ts
 *
 * Adds/removes the attribution hooks in ~/.claude/settings.json: one
 * `UserPromptSubmit` and one `Stop` hook, which mark the start and end of each
 * Claude turn (see claudeAttribution.ts), plus in per-file mode one
 * `PostToolUse` hook for the file-editing tools and Bash.
 *
 * The hook itself is deliberately dumb: it copies Claude Code's hook stdin JSON
 * into one file under ~/.claude-diff/claude-events/. No Python/Node needed;
 * all parsing happens in the extension (claudeAttribution.ts).
 *
 * The hook must print NOTHING to stdout: for `UserPromptSubmit`, Claude Code
 * adds stdout to Claude's context.
 *
 * Rules for editing settings.json:
 *  - Only rewrite settings.json on a SEMANTIC change. Running Claude sessions
 *    may stop trusting hooks when the file changes underneath them.
 *  - Never reset a malformed settings.json — refuse to write instead.
 *  - Only touch our own entries (identified by EVENTS_MARKER in the command).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EVENTS_MARKER = 'claude-events';
const OWNER_MARKER = 'claude-diff';
/** Generous: a slow PowerShell start must never lose a turn-start event. */
const HOOK_TIMEOUT_S = 30;
/** Hook events this extension may install an entry for (all removed when off). */
const OWNED_EVENTS = ['UserPromptSubmit', 'Stop', 'PostToolUse'] as const;
/** Tools whose PostToolUse tells which file Claude edited (Bash: that it ran a command). */
const POST_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

/** Which attribution hooks to have installed. */
export type AttributionHookMode = 'off' | 'turn' | 'perFile';

export function getClaudeEventsDir(): string {
  return path.join(os.homedir(), '.claude-diff', EVENTS_MARKER);
}

export function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

interface HookCommand {
  type: 'command';
  command: string;
  shell?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

function hookCommand(platform: string): HookCommand {
  if (platform === 'win32') {
    // Copy stdin as raw bytes: no text decoding, so non-ASCII paths (e.g.
    // Vietnamese folder names) survive regardless of the console code page.
    // (Setting [Console]::InputEncoding instead can throw when the hook runs
    // without a console attached, which is how Claude Code runs hooks.)
    return {
      type: 'command',
      shell: 'powershell',
      timeout: HOOK_TIMEOUT_S,
      command: [
        `$d=Join-Path $env:USERPROFILE '.${OWNER_MARKER}\\${EVENTS_MARKER}'`,
        'New-Item -ItemType Directory -Force -Path $d | Out-Null',
        "$t=Join-Path $d ('.'+[guid]::NewGuid().ToString()+'.tmp')",
        '$o=[IO.File]::Create($t); [Console]::OpenStandardInput().CopyTo($o); $o.Close()',
        "Move-Item -LiteralPath $t -Destination (Join-Path $d ([guid]::NewGuid().ToString()+'.json'))",
        'exit 0',
      ].join('; '),
    };
  }
  // Write to a temp name then rename, so the extension never reads half a file.
  return {
    type: 'command',
    timeout: HOOK_TIMEOUT_S,
    command:
      `d="$HOME/.${OWNER_MARKER}/${EVENTS_MARKER}"; mkdir -p "$d" && t="$d/.$$.tmp" && ` +
      `cat > "$t" && mv "$t" "$d/$(date +%s)-$$.json"; exit 0`,
  };
}

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some(
    h => typeof h.command === 'string' && h.command.includes(OWNER_MARKER) && h.command.includes(EVENTS_MARKER)
  );
}

function desiredGroups(platform: string, mode: AttributionHookMode): Partial<Record<string, HookGroup>> {
  if (mode === 'off') { return {}; }
  const cmd = hookCommand(platform);
  return {
    UserPromptSubmit: { hooks: [cmd] },
    Stop: { hooks: [cmd] },
    ...(mode === 'perFile' ? { PostToolUse: { matcher: POST_TOOL_MATCHER, hooks: [cmd] } } : {}),
  };
}

/** Pure: compute the new settings.json content. */
export function computeHookSettings(
  raw: string,
  mode: AttributionHookMode,
  platform: string = process.platform
): { content: string; changed: boolean; parseError?: boolean } {
  // Disabling with none of our entries in the file: nothing to remove, so
  // don't even parse it. (This runs on every startup while the feature is
  // off; it must stay silent for files we can't parse.)
  if (mode === 'off' && !(raw.includes(OWNER_MARKER) && raw.includes(EVENTS_MARKER))) {
    return { content: raw, changed: false };
  }

  // Windows editors (Notepad, PowerShell 5.1 `-Encoding utf8`) often save
  // with a UTF-8 BOM, which JSON.parse rejects. Parse without it and keep it.
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? raw.slice(1) : raw;

  let settings: Record<string, unknown>;
  if (!body.trim()) {
    settings = {};
  } else {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { content: raw, changed: false, parseError: true };
      }
      settings = parsed;
    } catch {
      return { content: raw, changed: false, parseError: true };
    }
  }

  const before = JSON.stringify(settings);
  const hooks = (settings['hooks'] && typeof settings['hooks'] === 'object' && !Array.isArray(settings['hooks']))
    ? { ...(settings['hooks'] as Record<string, unknown>) }
    : {};

  const desired = desiredGroups(platform, mode);
  for (const eventName of OWNED_EVENTS) {
    const list = Array.isArray(hooks[eventName]) ? (hooks[eventName] as HookGroup[]) : [];
    const others = list.filter(g => !isOurs(g));
    const group = desired[eventName];
    const next = group ? [...others, group] : others;
    if (next.length > 0) {
      hooks[eventName] = next;
    } else {
      delete hooks[eventName];
    }
  }

  if (Object.keys(hooks).length > 0) {
    settings['hooks'] = hooks;
  } else {
    delete settings['hooks'];
  }

  const after = JSON.stringify(settings);
  return { content: bom + JSON.stringify(settings, null, 2) + '\n', changed: before !== after };
}

export type HookApplyResult = 'unchanged' | 'installed' | 'removed' | 'parseError' | 'writeError';

export function applyClaudeAttributionHooks(mode: AttributionHookMode): HookApplyResult {
  const enabled = mode !== 'off';
  const settingsPath = getClaudeSettingsPath();
  let raw = '';
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    if (!enabled) { return 'unchanged'; }
  }

  const result = computeHookSettings(raw, mode);
  if (result.parseError) { return 'parseError'; }
  if (!result.changed) { return 'unchanged'; }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (raw) {
      fs.writeFileSync(settingsPath + '.claude-diff.bak', raw, 'utf8');
    }
    fs.writeFileSync(settingsPath, result.content, 'utf8');
    if (enabled) {
      fs.mkdirSync(getClaudeEventsDir(), { recursive: true });
    }
    return enabled ? 'installed' : 'removed';
  } catch {
    return 'writeError';
  }
}
