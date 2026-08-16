// Finds a working UTF-8 locale for the tmux/ttyd child processes,
// regardless of the locale of the shell that starts Claudux. Linux and
// macOS share no standard UTF-8 locale - Darwin has no glibc C.utf8 - so
// the preference is per platform, falling back to the first *.UTF-8 locale
// found and, as a last resort, to LC_CTYPE alone instead of a full LC_ALL.
import { execFileSync } from 'node:child_process';

export function pickUtf8Locale({ platform, availableLocales }) {
  const preferred = platform === 'linux' ? 'C.utf8' : 'en_US.UTF-8';
  if (availableLocales.includes(preferred)) {
    return { LC_ALL: preferred };
  }
  const firstUtf8 = availableLocales.find((l) => /\.utf-?8$/i.test(l));
  if (firstUtf8) {
    return { LC_ALL: firstUtf8 };
  }
  return { LC_CTYPE: 'UTF-8' };
}

let cached = null;

export function getUtf8LocaleEnv() {
  if (cached) return cached;
  let availableLocales = [];
  try {
    availableLocales = execFileSync('locale', ['-a'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    // `locale` is missing or fails - availableLocales stays empty and
    // pickUtf8Locale falls back to LC_CTYPE.
  }
  cached = pickUtf8Locale({ platform: process.platform, availableLocales });
  return cached;
}
