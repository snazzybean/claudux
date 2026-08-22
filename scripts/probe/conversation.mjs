// The conversation view on the real page, measured rather than looked at.
// Every check prints PASS or FAIL with what it measured; the run ends with a
// ratio and exits non-zero if anything failed. A failed PRECONDITION stops the
// run - with no session row or no transcript, everything below it would report
// on nothing.
//
// Playwright from the npx cache, like browser.mjs - it is not a dependency of
// this project. See README.md for what this exists for and what it does not
// cover.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { playwrightPath } from './paths.mjs';
import { sanitizePaneText } from '../../src/lib/paneText.js';
import { readDialog, promptIsEmpty } from '../../src/lib/paneDialog.js';

const { chromium } = await import(playwrightPath());

const [, , PORT = '', DATA = ''] = process.argv;
if (!PORT || !DATA) {
  console.error('Aufruf: node scripts/probe/conversation.mjs <port> <data>');
  process.exit(2);
}
const handoff = JSON.parse(fs.readFileSync(path.join(DATA, 'probe-conversation.json'), 'utf8'));
const { project: PROJECT, carrier: CARRIER, emptyCarrier: EMPTY, transcript: FILE } = handoff;
const HOOK_SECRET = crypto
  .createHmac('sha256', fs.readFileSync(path.join(DATA, 'permission-hook.key')))
  .update(CARRIER)
  .digest('hex');

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const results = [];
const problems = [];
function ok(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
// Thrown rather than exited on, so the browser is still closed on the way out.
class PreconditionFailed extends Error {}
function precondition(name, pass, detail) {
  ok(`precondition: ${name}`, pass, detail);
  if (!pass) throw new PreconditionFailed(name);
}
// Every wait that can time out goes through this: a bare `await` on a locator
// throws a stack trace instead of a verdict, and the run then has no ratio and
// leaves a browser behind.
async function survives(fn) {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

// ---------- appending to the transcript, the way Claude Code appends ----------

function lastUuid(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.uuid) return entry.uuid;
    } catch { /* a fragment is not an error */ }
  }
  return null;
}

function appendTurns(file, entries) {
  let parent = lastUuid(file);
  const out = [];
  for (const entry of entries) {
    const line = { ...entry, parentUuid: parent };
    parent = line.uuid;
    out.push(JSON.stringify(line));
  }
  fs.appendFileSync(file, `${out.join('\n')}\n`);
}

const appendLine = (file, entry) => appendTurns(file, [entry]);

// ---------- the boxes the card is drawn from ----------

// Invented captures, at one fixed width, put through the REAL sanitizePaneText
// and readDialog. Only the transport is substituted: this throwaway session
// runs a shell rather than `claude`, so there is no box on its pane to read,
// and a pane captured at the browser's own width would parse differently at
// each of the widths this run visits (readDialog folds a wrapped label against
// the widest line on the pane).
const BOXES = {
  permission: [
    '  Bash command',
    '',
    '    npm run lint',
    '',
    '  Do you want to run this command?',
    '',
    '  ❯ 1. Yes',
    '    2. Yes, and do not ask again for npm commands in this project',
    '    3. No, and tell Claude what to do differently (Esc)',
    '',
    '  Esc to cancel',
    '',
  ].join('\n'),
  question: [
    '  Which shape should the trunk take?',
    '',
    '    One line saying what this choice changes.',
    '',
    '  ❯ 1. Along the gap between the rows',
    '    2. Around the outside of both rows',
    '    3. Straight down the middle',
    '    4. Type something.',
    '    5. Chat about this',
    '',
    '  Esc to cancel',
    '',
  ].join('\n'),
  plan: [
    '  Ready to code?',
    '',
    '    Here is the plan it wrote.',
    '',
    '  ❯ 1. Yes, and auto-accept edits',
    '    2. Yes, and manually approve edits',
    '    3. No, keep planning',
    '',
    '  ctrl+g to edit in Vim',
    '',
  ].join('\n'),
};

const LONG_COMMAND = `grep -rn 'the one argument that identifies the call' ${'./a-directory-with-a-long-name'.repeat(6)}`;
const PLAN_TEXT = [
  '## What this changes',
  '',
  '1. The trunk runs along the gap between the two rows.',
  '2. Every window hangs off it by a short stub.',
  '3. A window below the trunk branches later than the one above it.',
  '',
  'The stubs occupy disjoint stretches, so there is nothing for them to',
  'cross but the trunk they all lie on.',
].join('\n');

// The payloads the PermissionRequest hook really posts, invented content in
// the fields the card reads.
const HOOKS = {
  permission: { tool_name: 'Bash', tool_input: { command: 'npm run lint' } },
  longTitle: { tool_name: 'Bash', tool_input: { command: LONG_COMMAND } },
  question: {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which shape should the trunk take, now that there are two rows of windows and one anchor beside them?' }] },
  },
  plan: { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN_TEXT } },
};

async function postHook(payload) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/permission/${CARRIER}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claudux-session-secret': HOOK_SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`hook POST answered ${res.status}`);
}

// ---------- the browser ----------

const scene = { box: null };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();

// A session whose transcript has not been written is a state the view has a
// sentence for, so its 404 is expected and only that one is.
const expected404 = (url) => url.includes(`/api/sessions/${EMPTY}/conversation`);
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  if (expected404(msg.location()?.url ?? '')) return;
  problems.push(`console: ${msg.text()}`);
});
page.on('response', (res) => {
  if (res.status() < 400 || expected404(res.url())) return;
  problems.push(`${res.status()} ${res.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
});

const calls = [];
page.on('request', (req) => {
  if (req.url().includes('/conversation?')) calls.push(req.url().replace(/^.*conversation/, ''));
});
// What each read actually brought back, so "the window was cut at the cap" is
// read off the wire rather than assumed from the timing.
const answers = [];
page.on('response', async (res) => {
  if (!res.url().includes('/conversation?') || !res.ok()) return;
  // Taken before the body is awaited: by the time it resolves, the read this
  // answer provoked can already be in the list, and "what came after" would
  // then start past it.
  const at = calls.length;
  try {
    const data = await res.json();
    answers.push({ q: res.url().replace(/^.*conversation/, ''), events: data.events.length, at });
  } catch { /* not the body this cares about */ }
});
let expected404s = 0;
page.on('requestfinished', async (req) => {
  const res = await req.response();
  if (res && res.status() === 404 && expected404(req.url())) expected404s += 1;
});

// A tail read resets the 30 s budget behind it, so what follows for the next
// half minute are polls. Waiting for one is how the capped-window check gets a
// POLL to be the read that has to notice the cut.
async function waitForTailRead(timeoutMs = 45000) {
  const from = calls.length;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (calls.slice(from).some((url) => url.includes('tail=1'))) return true;
    await wait(500);
  }
  return false;
}

// The pane only while a scene is set; otherwise the real route answers, which
// for this session is a shell with no box open.
await page.route('**/api/sessions/*/pane', (route) => {
  if (!scene.box) return route.fallback();
  const clean = sanitizePaneText(BOXES[scene.box]);
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ raw: clean, clean, dialog: readDialog(clean), promptEmpty: promptIsEmpty(clean) }),
  });
});

const wait = (ms) => page.waitForTimeout(ms);
const streamText = () => page.locator('#conversationStream').innerText();

// Everything below reports; the finally at the bottom is what guarantees the
// browser goes away even when it does not.
let stopped = null;
try {

  // ---------- precondition: the real page, the real session, the real ttyd ----------

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  const rowOpened = await survives(async () => {
    await page.waitForSelector('.project-head', { timeout: 20000 });
    // On the name element, not the head: the head shows the project's path
  // too, and this project's path contains its own name.
  await page.locator('.project-head')
    .filter({ has: page.locator('.project-name', { hasText: exactly(PROJECT) }) })
    .first().click({ timeout: 20000 });
    await page.locator(`.session-row[data-session-id="${CARRIER}"]`).click({ timeout: 20000 });
  });
  precondition('the session has a row of its own, and it opens', rowOpened, CARRIER.slice(0, 8));
  const termLive = await survives(() => page.waitForFunction(() => {
    const frame = document.getElementById('terminalFrame').contentWindow;
    return Boolean(frame && frame.term && frame.term.buffer);
  }, { timeout: 30000 }));
  precondition('the terminal really attaches (ttyd, tmux, window.term)', termLive);

  // ---------- the three tabs on a narrow phone ----------

  await page.setViewportSize({ width: 320, height: 700 });
  await wait(400);
  const narrow = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) }; };
    const group = document.getElementById('overlayGroup');
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return Boolean(at && (at === el || el.contains(at)));
    };
    const tabs = ['tabTerminal', 'tabFiles', 'tabConversation'].map((id) => document.getElementById(id));
    return {
      group: box(group),
      tabsHit: tabs.map(hit),
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  ok('three tabs fit on a 320px phone',
    narrow.group.x >= 0 && narrow.group.right <= 320 && narrow.docOverflow <= 0,
    `group ${narrow.group.x}..${narrow.group.right} of 320, sideways overflow ${narrow.docOverflow}px`);
  ok('and each of the three can be tapped',
    narrow.tabsHit.every(Boolean), JSON.stringify(narrow.tabsHit));
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(400);

  // ---------- the terminal is hidden, not unloaded ----------

  const termId = await page.evaluate(() => {
    // A mark on ttyd's own document: it survives a tab switch exactly as long as
    // the iframe is not reloaded or rebuilt, which is what "hidden" has to mean
    // here - the composer sends through this very window.
    const frame = document.getElementById('terminalFrame').contentWindow;
    frame.__probeMark = 'kept';
    return Boolean(frame.term);
  });
  const filled = await survives(async () => {
    await page.locator('#tabConversation').click({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.conversation-event').length > 0, { timeout: 30000 });
  });
  precondition('the third tab opens onto the transcript', filled);
  await wait(800);
  const hidden = await page.evaluate(() => {
    const frame = document.getElementById('terminalFrame');
    return {
      present: Boolean(frame),
      display: frame ? getComputedStyle(frame).display : null,
      term: Boolean(frame?.contentWindow?.term),
      mark: frame?.contentWindow?.__probeMark ?? null,
    };
  });
  ok('the terminal is hidden but still there', hidden.present && hidden.display === 'none',
    `display ${hidden.display}`);
  ok('and its document was not reloaded (window.term survives)',
    termId && hidden.term && hidden.mark === 'kept', `term ${hidden.term}, mark ${hidden.mark}`);

  const wentBack = await survives(async () => {
    await page.locator('#tabTerminal').click({ timeout: 20000 });
    await wait(400);
    await page.locator('#tabConversation').click({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.conversation-event').length > 0, { timeout: 30000 });
  });
  await wait(600);
  const roundTrip = await page.evaluate(() => {
    const frame = document.getElementById('terminalFrame').contentWindow;
    return { term: Boolean(frame?.term), mark: frame?.__probeMark ?? null };
  });
  ok('and it survives the round trip back and forth',
    wentBack && roundTrip.term && roundTrip.mark === 'kept', `term ${roundTrip.term}, mark ${roundTrip.mark}`);

  // ---------- what the tree filter did with the transcript ----------

  const text = await streamText();
  ok('an abandoned branch is not shown', !text.includes('this one was taken back'));
  ok('the segment before the second root stays visible', text.includes('first segment, before the compact'));

  const thinking = await page.evaluate(() => {
    const details = document.querySelector('#conversationStream .conversation-thinking details');
    if (!details) return null;
    const body = details.querySelector('.conversation-foldout-body');
    return { open: details.open, visible: body.checkVisibility() };
  });
  ok('thinking starts collapsed', thinking !== null && thinking.open === false && thinking.visible === false,
    JSON.stringify(thinking));

  // The whole "no search bar in version one" cut rests on this one. The nonsense
  // control comes first: without it a window.find that always answered true
  // would report this as passing.
  const search = await page.evaluate(() => {
    const clear = () => window.getSelection().removeAllRanges();
    clear();
    const nonsense = window.find('zzqq-nothing-on-this-page-says-this-zzqq');
    clear();
    const hidden = window.find('weighing two options before the measurement');
    clear();
    const opened = document.querySelector('#conversationStream .conversation-thinking details')?.open ?? null;
    return { nonsense, hidden, opened };
  });
  ok('the page search does not answer for text that is not there', search.nonsense === false);
  ok('the page search reaches text inside a closed details',
    search.nonsense === false && search.hidden === true,
    `found ${search.hidden}, the details stayed ${search.opened ? 'open' : 'closed'}`);

  const queue = await page.evaluate(() => {
    const box = document.getElementById('conversationQueue');
    return { hidden: box.hidden, display: getComputedStyle(box).display, text: box.innerText };
  });
  ok('the two waiting messages are listed',
    queue.hidden === false && queue.display !== 'none'
    && queue.text.includes('a message that is waiting') && queue.text.includes('and a second one behind it'),
    `hidden ${queue.hidden}, display ${queue.display}`);

  // ---------- subagent cards ----------

  const cards = await page.evaluate(() => [...document.querySelectorAll('#conversationStream .conversation-task')]
    .map((node) => ({
      text: node.textContent.trim().slice(0, 160),
      openable: Boolean(node.querySelector(':scope > details')),
    })));
  ok('three subagent cards, and only the resolvable one opens',
    cards.length === 3 && cards.filter((c) => c.openable).length === 1,
    JSON.stringify(cards.map((c) => c.openable)));
  ok('the card whose call id is on disk says which agent it is',
    cards[0]?.openable === true && /look around/.test(cards[0]?.text ?? ''), cards[0]?.text);
  ok('several agents under one name reads as undecidable, not as absent',
    cards[1]?.openable === false && /several agents ran under this name/.test(cards[1]?.text ?? ''),
    cards[1]?.text);
  ok('a name nothing on disk carries reads as no transcript',
    cards[2]?.openable === false && /no transcript on disk names this one/.test(cards[2]?.text ?? ''),
    cards[2]?.text);

  let cardOpened = false;
  await page.evaluate(() => { document.querySelector('.conversation-task > details').open = true; });
  try {
    await page.waitForFunction(
      () => /Eleven stubs/.test(document.querySelector('.conversation-task').textContent),
      { timeout: 15000 },
    );
    cardOpened = true;
  } catch { /* reported below */ }
  ok('and it opens onto that agent\'s own conversation', cardOpened);
  await page.evaluate(() => { document.querySelector('.conversation-task > details').open = false; });

  // ---------- following live, without pulling the ground away ----------

  const before = await page.evaluate(() => {
    const el = document.getElementById('conversationStream');
    // Away from the end, but not into the top trigger that pages upwards.
    el.scrollTop = Math.round(el.scrollHeight * 0.5);
    for (const node of el.querySelectorAll('.conversation-event')) node.__probe = 'kept';
    const last = [...el.querySelectorAll('details')].pop();
    if (last) last.open = true;
    const anchor = [...el.querySelectorAll('.conversation-event')]
      .find((n) => n.getBoundingClientRect().bottom > el.getBoundingClientRect().top + 10);
    return {
      events: el.querySelectorAll('.conversation-event').length,
      scrollTop: Math.round(el.scrollTop),
      openFoldouts: [...el.querySelectorAll('details')].filter((d) => d.open).length,
      anchorUuid: anchor?.dataset.uuid ?? null,
      anchorTop: Math.round(anchor?.getBoundingClientRect().top ?? 0),
    };
  });
  await wait(600);
  const startedAt = Date.now();
  appendLine(FILE, { type: 'assistant', uuid: 'live1', entrypoint: 'cli', message: { content: [{ type: 'text', text: 'appended while watching' }] } });
  let arrivedMs = null;
  try {
    await page.waitForFunction(
      () => document.getElementById('conversationStream').innerText.includes('appended while watching'),
      { timeout: 15000 },
    );
    arrivedMs = Date.now() - startedAt;
  } catch { /* reported below */ }
  await wait(500);
  const after = await page.evaluate((anchorUuid) => {
    const el = document.getElementById('conversationStream');
    const anchor = anchorUuid ? el.querySelector(`.conversation-event[data-uuid="${anchorUuid}"]`) : null;
    return {
      events: el.querySelectorAll('.conversation-event').length,
      kept: [...el.querySelectorAll('.conversation-event')].filter((n) => n.__probe === 'kept').length,
      openFoldouts: [...el.querySelectorAll('details')].filter((d) => d.open).length,
      scrollTop: Math.round(el.scrollTop),
      anchorTop: anchor ? Math.round(anchor.getBoundingClientRect().top) : null,
      jumpHidden: document.getElementById('conversationJump').hidden,
    };
  }, before.anchorUuid);
  ok('an appended line arrives without a reload',
    arrivedMs !== null && arrivedMs < 10000, arrivedMs === null ? 'never arrived' : `${(arrivedMs / 1000).toFixed(1)}s`);
  ok('the nodes already on screen are kept, not rebuilt',
    after.kept === before.events, `${before.events} stamped -> ${after.kept} still stamped`);
  ok('an open foldout survives the poll',
    before.openFoldouts > 0 && after.openFoldouts === before.openFoldouts,
    `${before.openFoldouts} -> ${after.openFoldouts}`);
  ok('and the scroll does not jump',
    after.anchorTop !== null && Math.abs(after.anchorTop - before.anchorTop) <= 2,
    `anchor at ${before.anchorTop}px -> ${after.anchorTop}px, jump button ${after.jumpHidden ? 'hidden' : 'shown'}`);
  ok('reaching the end again is offered rather than forced', after.jumpHidden === false);
  await survives(() => page.locator('#conversationJump').click({ timeout: 10000 }));
  await wait(600);

  // ---------- the dialog card ----------

  const measureCard = () => page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
    const hit = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return Boolean(at && (at === el || el.contains(at)));
    };
    const panel = document.querySelector('.conversation-panel');
    const dialog = document.getElementById('conversationDialog');
    const list = document.querySelector('.conversation-dialog-options');
    const options = [...document.querySelectorAll('.conversation-dialog-option')];
    // The last answer is the one a scroller can hide; the two keys sit outside
    // it and have to be there without any scrolling at all.
    if (list) list.scrollTop = list.scrollHeight;
    const keys = [...document.querySelectorAll('.conversation-dialog-key')];
    return {
      cardShown: !dialog.hidden,
      title: document.querySelector('.conversation-dialog-title')?.textContent ?? null,
      plan: Boolean(document.querySelector('.conversation-dialog-plan')),
      options: options.length,
      optionKeys: options.map((el) => el.textContent.split(' · ')[0]),
      // .conversation-panel is overflow:hidden, so anything past its client box
      // is simply gone.
      panelClipped: Math.round(panel.scrollHeight - panel.clientHeight),
      lastOptionHit: hit(options.at(-1)),
      keysHit: keys.map(hit),
      keysBottom: keys.length ? box(keys.at(-1)).bottom : null,
      panelBottom: box(panel).bottom,
      appBottom: box(document.getElementById('app')).bottom,
      composerHidden: document.getElementById('conversationComposer').hidden,
      queueDisplay: getComputedStyle(document.getElementById('conversationQueue')).display,
      hint: [...document.querySelectorAll('.conversation-hint')].map((el) => el.textContent).join(' | '),
      streamHeight: Math.round(document.getElementById('conversationStream').getBoundingClientRect().height),
    };
  });

  await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '400px'));
  for (const [label, boxKind, hookKind, wantOptions, wantTitle] of [
    ['a permission box', 'permission', 'permission', 3, /^Bash · npm run lint$/],
    ['a permission box with a long title', 'permission', 'longTitle', 3, /^Bash · grep -rn .{100,}$/],
    ['a question with five options', 'question', 'question', 5, /^Which shape should the trunk take/],
    ['a plan confirmation', 'plan', 'plan', 3, /^Ready to execute this plan$/],
  ]) {
    scene.box = boxKind;
    await postHook(HOOKS[hookKind]);
    let stands = false;
    try {
      // The title too, not only the option count: two scenes in a row can offer
      // the same three keys, and waiting on the count alone would measure the
      // previous card.
      await page.waitForFunction(
        ({ n, title }) => document.querySelectorAll('.conversation-dialog-option').length === n
          && new RegExp(title).test(document.querySelector('.conversation-dialog-title')?.textContent ?? ''),
        { n: wantOptions, title: wantTitle.source }, { timeout: 25000 },
      );
      stands = true;
    } catch { /* reported below */ }
    await wait(300);
    const card = await measureCard();
    ok(`${label}: the card stands and the composer is gone`,
      stands && card.cardShown && card.composerHidden === true,
      `options ${card.options}, title ${(card.title ?? '').length} chars, composer hidden ${card.composerHidden}`);
    ok(`${label}: the queue gives way and the card says what waits`,
      card.queueDisplay === 'none' && /2 message\(s\) waiting behind this box\./.test(card.hint),
      `queue ${card.queueDisplay}, hint "${card.hint}"`);
    ok(`${label}: nothing is clipped at 400px of app height`,
      card.panelClipped === 0 && card.keysBottom <= card.appBottom,
      `clipped ${card.panelClipped}px, keys end ${card.keysBottom} of ${card.appBottom}, stream ${card.streamHeight}px`);
    ok(`${label}: the last answer and both keys can be tapped`,
      card.lastOptionHit === true && card.keysHit.every(Boolean),
      `last option ${card.lastOptionHit}, keys ${JSON.stringify(card.keysHit)}, title "${(card.title ?? '').slice(0, 48)}…"`);
    if (hookKind === 'plan') {
      ok(`${label}: the plan itself is on the card`, card.plan === true);
    }
  }
  scene.box = null;
  const cardWentAway = await survives(() => page.waitForFunction(
    () => document.getElementById('conversationDialog').hidden === true, { timeout: 20000 },
  ));
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-height'));
  await wait(400);
  const closed = await page.evaluate(() => ({
    composerHidden: document.getElementById('conversationComposer').hidden,
    queueDisplay: getComputedStyle(document.getElementById('conversationQueue')).display,
  }));
  ok('once the box is answered the composer and the queue come back',
    cardWentAway && closed.composerHidden === false && closed.queueDisplay !== 'none',
    `card gone ${cardWentAway}, ${JSON.stringify(closed)}`);

  // ---------- a poll window cut at the server's event cap ----------

  const tailSeen = await waitForTailRead();
  ok('precondition for the next two: a tail read has just run', tailSeen);
  const baseline = await page.evaluate(() => ({
    events: document.querySelectorAll('.conversation-event').length,
    firstOnScreen: document.querySelector('#conversationStream .conversation-event')?.dataset.uuid ?? null,
  }));
  const mark = calls.length;
  const answerMark = answers.length;
  appendTurns(FILE, Array.from({ length: 260 }, (_, i) => ({
    type: 'user',
    uuid: `catchup-${String(i).padStart(4, '0')}`,
    entrypoint: 'cli',
    message: { content: [{ type: 'text', text: `catch-up turn ${i}` }] },
  })));
  let caught = false;
  try {
    await page.waitForFunction(
      () => document.getElementById('conversationStream').innerText.includes('catch-up turn 259'),
      { timeout: 30000 },
    );
    caught = true;
  } catch { /* reported below */ }
  await wait(3000);
  const capped = await page.evaluate((firstUuid) => {
    const nodes = [...document.querySelectorAll('#conversationStream .conversation-event')];
    const firstCatchup = nodes.findIndex((n) => (n.dataset.uuid ?? '').startsWith('catchup-'));
    return {
      events: nodes.length,
      baseStillThere: nodes.some((n) => n.dataset.uuid === firstUuid),
      above: firstCatchup > 0 ? nodes[firstCatchup - 1].textContent.trim().slice(0, 40) : null,
      firstCatchup: firstCatchup >= 0 ? nodes[firstCatchup].textContent.trim().slice(0, 40) : null,
    };
  }, baseline.firstOnScreen);
  const since = calls.slice(mark);
  const cappedAt = answers.slice(answerMark).findIndex((a) => a.q.includes('after=') && a.events >= 200);
  const cappedPoll = cappedAt === -1 ? null : answers[answerMark + cappedAt];
  const tailAfter = cappedPoll ? calls.slice(cappedPoll.at).some((url) => url.includes('tail=1')) : false;
  ok('a capped poll window is re-read instead of appended to',
    caught && cappedPoll !== null && tailAfter,
    cappedPoll
      ? `${cappedPoll.q} came back with ${cappedPoll.events} events, tail read behind it: ${tailAfter}, catch-up on screen: ${caught}`
      : `no poll window came back at the cap (${since.length} requests: ${since.join(' ')})`);
  ok('and it does not stitch a hole shut silently',
    capped.baseStillThere === false && capped.events <= 200,
    `${baseline.events} -> ${capped.events} events, the old first turn is ${capped.baseStillThere ? 'STILL there' : 'gone'}, above the first catch-up turn: ${capped.above ?? 'nothing'}`);

  // ---------- a session whose transcript has not been written yet ----------

  const noticed = await survives(async () => {
    await page.locator('#backBtn').click({ timeout: 20000 });
    await wait(400);
    await page.locator(`.session-row[data-session-id="${EMPTY}"]`).click({ timeout: 20000 });
    await wait(1500);
    await page.locator('#tabConversation').click({ timeout: 20000 });
    await page.waitForFunction(
      () => document.getElementById('conversationStream').innerText.includes('No conversation yet'),
      { timeout: 20000 },
    );
  });
  ok('a session with no transcript says so instead of staying blank', noticed,
    (await streamText()).trim().slice(0, 80));

  // ---------- what the page complained about ----------

  // The count first: without it, "no problems" would also be the answer where
  // the allowance had swallowed everything, the 404 included.
  ok('the expected 404 really happened and was not counted', expected404s > 0, `${expected404s} of them`);
  ok('no page errors, and no failed request beyond the expected 404',
    problems.length === 0, problems.length ? problems.join(' | ') : 'none');

} catch (err) {
  if (err instanceof PreconditionFailed) stopped = err.message;
  // Anything else is the probe falling over, and that is a result too - a
  // stack trace with no ratio behind it is not.
  else ok('the probe itself got through the run', false, `${err.name}: ${err.message.split('\n')[0]}`);
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const passed = results.filter(Boolean).length;
if (stopped) console.log(`\nstopped after a failed precondition (${stopped}) - the checks below it would report on nothing`);
console.log(`${passed}/${results.length} pass`);
process.exit(passed === results.length && !stopped ? 0 : 1);
