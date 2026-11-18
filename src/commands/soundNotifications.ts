import * as fs from 'fs';
import * as path from 'path';

/**
 * soundNotifications.ts
 *
 * Bật/tắt âm thanh thông báo (Claude vừa xong lượt / cần input) qua hook
 * `Notification`/`Stop` trong `~/.claude/settings.json`. Đây là tính năng độc
 * lập với diff detection; chỉ động vào entry của chính nó dưới đúng 2 key này,
 * giữ nguyên mọi hook khác user đã có sẵn.
 */

const SOUND_MARKER = 'System.Media.SoundPlayer';
/** Appended as a PowerShell comment, so only our sound hooks are ever removed. */
const OWNER_MARKER = 'claude-diff';

function isOurSoundCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(SOUND_MARKER) && command.includes(OWNER_MARKER);
}

function getClaudeSettingsPath(): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  return path.join(home, '.claude', 'settings.json');
}

function soundHookEntry(wavPath: string): unknown {
  return [
    {
      hooks: [
        {
          type: 'command',
          shell: 'powershell',
          command: `(New-Object ${SOUND_MARKER} '${wavPath}').PlaySync() # ${OWNER_MARKER}`,
          async: true,
        },
      ],
    },
  ];
}

/**
 * Ghi/xoá hook Notification+Stop trong `~/.claude/settings.json` theo giá trị
 * `enabled`. Chỉ hỗ trợ Windows (dùng `System.Media.SoundPlayer` qua
 * PowerShell) — no-op trên platform khác.
 */
export function applySoundNotifications(enabled: boolean): void {
  if (process.platform !== 'win32') {
    return;
  }

  const settingsPath = getClaudeSettingsPath();
  const settingsDir = path.dirname(settingsPath);

  let settings: Record<string, unknown> = {};
  let fileExists = true;
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    fileExists = false;
  }
  // Turning sound off with no sound hook in the file: nothing to do, so don't
  // even parse the file.
  if (!enabled && raw !== undefined && !(raw.includes(SOUND_MARKER) && raw.includes(OWNER_MARKER))) {
    return;
  }
  // Windows editors often save with a UTF-8 BOM, which JSON.parse rejects.
  const bom = raw?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? raw!.slice(1) : raw;
  if (body !== undefined && body.trim()) {
    try {
      settings = JSON.parse(body);
    } catch {
      return; // malformed user config — never overwrite it with {}
    }
  }

  if (!enabled && !fileExists) {
    return;
  }

  const hooks = { ...(settings['hooks'] as Record<string, unknown> | undefined ?? {}) };
  const before = JSON.stringify(settings['hooks'] ?? {});

  // Only add/remove OUR entries (SoundPlayer + the owner marker in the
  // command), never the user's own Notification/Stop hooks — including any
  // SoundPlayer hooks they wrote themselves.
  const setOurs = (key: string, wavPath: string) => {
    const list = Array.isArray(hooks[key]) ? (hooks[key] as Array<{ hooks?: Array<{ command?: unknown }> }>) : [];
    const others = list.filter(g => !(g.hooks ?? []).some(h => isOurSoundCommand(h.command)));
    const next = enabled ? [...others, ...(soundHookEntry(wavPath) as unknown[])] : others;
    if (next.length > 0) { hooks[key] = next; } else { delete hooks[key]; }
  };
  setOurs('Notification', 'C:\\Windows\\Media\\Alarm10.wav');
  setOurs('Stop', 'C:\\Windows\\Media\\tada.wav');

  if (JSON.stringify(hooks) === before) {
    return; // no semantic change → don't touch settings.json
  }

  settings['hooks'] = hooks;

  if (!fs.existsSync(settingsDir)) {
    if (!enabled) {
      return;
    }
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, bom + JSON.stringify(settings, null, 2), 'utf8');
}
