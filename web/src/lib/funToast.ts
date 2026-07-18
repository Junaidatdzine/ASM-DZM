import { toast } from 'sonner';

/**
 * Every toast in the app gets a small dose of joy: a random, mood-matched emoji
 * prepended to its title. Installed once at bootstrap — no need to touch the
 * ~hundred toast call sites, and new toasts get it for free.
 */
const POOLS = {
  success: ['🎉', '✨', '🚀', '🙌', '🥳', '💫', '😎', '🌈', '🏆', '👏', '💪', '🤩'],
  error: ['😅', '🙈', '🫣', '🛠️', '🧯', '🤕', '😬'],
  warning: ['🤔', '😬', '⏳', '🧐', '👀'],
  info: ['💡', '👀', '📣', '✨', '🛰️'],
} as const;

const pick = (list: readonly string[]) => list[Math.floor(Math.random() * list.length)]!;

let installed = false;

export function installFunToasts(): void {
  if (installed) return;
  installed = true;
  for (const kind of ['success', 'error', 'warning', 'info'] as const) {
    const original = toast[kind].bind(toast);
    (toast as unknown as Record<string, unknown>)[kind] = (
      message: unknown,
      options?: Record<string, unknown>,
    ) =>
      original(
        typeof message === 'string' ? `${pick(POOLS[kind])} ${message}` : (message as never),
        options as never,
      );
  }
}
