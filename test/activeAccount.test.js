// test/activeAccount.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenFromEnv, parsePaneList, resolveActiveAccounts } from '../src/lib/activeAccount.js';

// Only the process environment names the token `claude` actually runs with;
// the mapping remembered at start time can drift from it.

test('tokenFromEnv reads CLAUDE_CODE_OAUTH_TOKEN from a /proc/<pid>/environ content', () => {
  // environ is NUL-separated, not line-separated.
  // 'sk-test-token' is on the pre-push guard's allow-list; the value is
  // arbitrary, the parsing is what's under test.
  const raw = ['PATH=/usr/bin', 'CLAUDE_CODE_OAUTH_TOKEN=sk-test-token', 'TERM=xterm'].join('\0');

  assert.equal(tokenFromEnv(raw), 'sk-test-token');
});

test('tokenFromEnv returns null when the variable is missing', () => {
  assert.equal(tokenFromEnv(['PATH=/usr/bin', 'TERM=xterm'].join('\0')), null);
});

// A prefix match must not be enough: CLAUDE_CODE_OAUTH_TOKEN_FILE or
// similar would be a different variable.
test('tokenFromEnv does not match a merely similarly named variable', () => {
  assert.equal(tokenFromEnv('CLAUDE_CODE_OAUTH_TOKEN_ALT=abc'), null);
});

// A token value may contain equals signs (base64 padding) - the value is
// split at the FIRST '=', not every one.
test('tokenFromEnv keeps equals signs in the token value', () => {
  assert.equal(tokenFromEnv('CLAUDE_CODE_OAUTH_TOKEN=sk-test-token=a=b'), 'sk-test-token=a=b');
});

// `tmux list-panes -a` returns all panes of all sessions in ONE call -
// important because this lookup runs on every load of the session list,
// and one call per session would otherwise add up.
test('parsePaneList maps session names to their pane PIDs', () => {
  const raw = 'sess-a:1234\nsess-b:5678\n';

  assert.deepEqual(parsePaneList(raw), [
    { sessionName: 'sess-a', panePid: '1234' },
    { sessionName: 'sess-b', panePid: '5678' },
  ]);
});

// Multiple panes per session are possible; for the account question the
// first one is enough, all panes of a session share the same environment.
test('parsePaneList keeps only the first of multiple panes in the same session', () => {
  const raw = 'sess-a:1234\nsess-a:1235\nsess-b:5678\n';

  assert.deepEqual(parsePaneList(raw), [
    { sessionName: 'sess-a', panePid: '1234' },
    { sessionName: 'sess-b', panePid: '5678' },
  ]);
});

test('parsePaneList handles empty output (no tmux server)', () => {
  assert.deepEqual(parsePaneList(''), []);
});

// Both fixture values sit on the pre-push guard's allow-list; anything else
// after CLAUDE_CODE_OAUTH_TOKEN= would be blocked.
test('resolveActiveAccounts tells the three states apart', async () => {
  const resolver = (token) => (token === 'sk-test-token' ? 'id-1' : null);
  const map = await resolveActiveAccounts(resolver, {
    listPanesFn: async () => 'sess-known:101\nsess-foreign:102\nsess-none:103\n',
    readEnvironFn: async (pid) => ({
      101: 'CLAUDE_CODE_OAUTH_TOKEN=sk-test-token\0',
      102: 'CLAUDE_CODE_OAUTH_TOKEN=sk-nope\0',
      103: 'PATH=/usr/bin\0',
    })[pid],
  });

  assert.deepEqual(map.get('sess-known'), { accountId: 'id-1', hasToken: true });
  assert.deepEqual(map.get('sess-foreign'), { accountId: null, hasToken: true });
  assert.deepEqual(map.get('sess-none'), { accountId: null, hasToken: false });
});
