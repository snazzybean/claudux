import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function detectMissingBinaries({ checkFn, binaries = ['tmux', 'ttyd'] }) {
  return binaries.filter((bin) => !checkFn(bin));
}

// The real availability check, kept outside the pure function above.
// "command -v" rather than "which": it is a shell builtin and exists on
// every POSIX shell without an extra package.
export function binaryExists(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectPackageManager({ platform, checkFn }) {
  if (platform === 'darwin') {
    return checkFn('brew') ? 'brew' : null;
  }
  if (checkFn('apt-get')) return 'apt';
  if (checkFn('dnf')) return 'dnf';
  if (checkFn('pacman')) return 'pacman';
  return null;
}

export function installCommandFor(manager, binaries) {
  switch (manager) {
    case 'brew':
      return ['brew', 'install', ...binaries];
    case 'apt':
      return ['apt-get', 'install', '-y', ...binaries];
    case 'dnf':
      return ['dnf', 'install', '-y', ...binaries];
    case 'pacman':
      return ['pacman', '-S', '--noconfirm', ...binaries];
    default:
      throw new Error(`Unknown package manager: ${manager}`);
  }
}

async function promptYesNo(rl, question) {
  const answer = await rl.question(`${question} [y/N] `);
  return answer.trim().toLowerCase() === 'y';
}

function runInstall(cmd, { needsSudo }) {
  const result = spawnSync(needsSudo ? 'sudo' : cmd[0], needsSudo ? cmd : cmd.slice(1), {
    stdio: 'inherit',
  });
  return result.status === 0;
}

// Split out of main() so the npx entry point can check the same
// prerequisites without also writing a .env into the npm cache.
export async function ensurePrerequisites({
  checkFn = binaryExists,
  platform = process.platform,
  confirmFn,
  installFn = runInstall,
  log = console.log,
  logError = console.error,
} = {}) {
  const missing = detectMissingBinaries({ checkFn });
  if (missing.length > 0) {
    log(`Missing: ${missing.join(', ')}`);
    const manager = detectPackageManager({ platform, checkFn });
    if (manager) {
      const cmd = installCommandFor(manager, missing);
      if (await confirmFn(`Install with "${cmd.join(' ')}"?`)) {
        if (!installFn(cmd, { needsSudo: manager !== 'brew' })) {
          logError('Installation failed - please install manually.');
        }
      } else {
        log(`Please install manually: ${cmd.join(' ')}`);
      }
    } else {
      log(`No known package manager detected - please install ${missing.join(', ')} manually.`);
    }
  } else {
    log('tmux and ttyd are present.');
  }

  const claudePresent = checkFn('claude');
  log(
    claudePresent
      ? 'Claude Code CLI is present.'
      : 'Claude Code CLI not found - see https://docs.claude.com/claude-code for installation and "claude setup-token" for the account.',
  );

  try {
    const mouseSetting = execFileSync('tmux', ['show-options', '-g', 'mouse'], { encoding: 'utf8' }).trim();
    if (mouseSetting.includes('on')) {
      log('Warning: tmux has "mouse on" set globally - this breaks Claudux\'s copy feature (see README, Requirements).');
    }
  } catch {
    // tmux not installed, or no server yet - nothing to warn about.
  }

  return { missing, claudePresent };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Node: ${process.version}`);
    await ensurePrerequisites({ confirmFn: (question) => promptYesNo(rl, question) });

    const envPath = path.join(REPO_ROOT, '.env');
    if (!fs.existsSync(envPath)) {
      fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), envPath);
      console.log('.env created from .env.example.');
      console.log('PUBLIC_BASE_URL is commented out - set it to make notifications link back to this installation. Notification targets themselves are configured in the settings dialog, not here. CLAUDE_HOME and ACCOUNTS_SECRET_PATH are commented out too and already default sensibly.');
    } else {
      console.log('.env already exists, left untouched.');
    }

    console.log('\nDone. Continue with: npm start');
  } finally {
    rl.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
