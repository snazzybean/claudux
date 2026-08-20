import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadProjects } from '../lib/projectStore.js';
import {
  buildNewSessionArgs,
  spawnTmux,
  isValidSlug,
  hasSession,
  waitForSession,
  disableStatusBar,
  setRemainOnExit,
  showBuffer,
  capturePane,
  killSession,
  listTmuxSessions,
  isUnwantedDeath,
} from '../lib/tmuxManager.js';
import { sanitizePaneText } from '../lib/paneText.js';
import { setMeta, getMeta, tmuxSessionFor, recordClaudeSwitch, claudeSessionIdsForTmux } from '../lib/sessionMeta.js';
import { chooseTranscript } from '../lib/contextUsage.js';
import { subagentsDirFor, AGENT_ID_RE } from '../lib/subagentWatcher.js';
import { readAgentBlocks } from '../lib/agentTranscript.js';
import { getTokenById, getAccountById, listAccounts } from '../lib/accountStore.js';
import { writeSessionTokenFile, removeSessionTokenFile } from '../lib/sessionTokenFile.js';
import { ensureOnboardingCompleted } from '../lib/onboardingFlag.js';

export function sessionsRouter(config) {
  const router = express.Router();
  const projectsConfigPath = path.join(config.dataDir, 'projects.json');

  router.post('/projects/:id/sessions', async (req, res, next) => {
    try {
      const { accountId } = req.body ?? {};
      const project = loadProjects(projectsConfigPath).find((p) => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const token = getTokenById(config.accountsSecretPath, accountId);
      if (!token) return res.status(400).json({ error: `Unknown account: ${accountId}` });

      const sessionId = crypto.randomUUID();
      // The token goes through a 0600 file instead of argv - otherwise it
      // would be readable via `ps aux` for every local account (see
      // sessionTokenFile.js). The wrapper script deletes it on startup.
      const tokenFilePath = writeSessionTokenFile(config.dataDir, sessionId, token);
      // Before the pane starts, not after: `claude` reads onboarding state
      // at its own startup, right after this call.
      ensureOnboardingCompleted();
      const args = buildNewSessionArgs({ sessionId, projectPath: project.path, tokenFilePath, resume: false });
      spawnTmux(args);
      // Only respond once the session actually exists - otherwise the
      // frontend sets the ttyd iframe src before `tmux new-session` is
      // done.
      const started = await waitForSession(sessionId);
      // Only clean up on failure. waitForSession returns as soon as the
      // session EXISTS - not once the wrapper has read the token. An
      // unconditional delete would pull the file out from under it. On
      // success the wrapper deletes it itself; whatever's left is picked
      // up by cleanupSessionTokenFiles() on the next startup.
      if (!started) removeSessionTokenFile(config.dataDir, sessionId);
      // Must run AFTER waitForSession, otherwise `set-option` addresses a
      // session that doesn't exist yet.
      await disableStatusBar(sessionId);
      // After waitForSession, not chained onto new-session: tmux's argv
      // grammar for the shell-command part is too poorly documented to
      // build a `;` chain on. That leaves a race for a crash in the first
      // milliseconds - a start failure, which attach.sh catches, and the
      // wrapper holds a missing token file open by itself.
      await setRemainOnExit(sessionId);
      setMeta(config.dataDir, sessionId, { accountId, projectId: project.id });

      res.status(201).json({ id: sessionId, terminalUrl: `/ttyd/?arg=${sessionId}` });
    } catch (err) {
      next(err);
    }
  });

  // The hand-callable entry to recordClaudeSwitch(): the tmux session :id
  // now carries the conversation with the Claude ID from the body.
  router.post('/sessions/:id/claude-switch', (req, res, next) => {
    try {
      const tmuxSession = req.params.id;
      const { claudeSessionId } = req.body ?? {};
      if (!isValidSlug(tmuxSession) || !isValidSlug(claudeSessionId ?? '')) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }
      const saved = recordClaudeSwitch(config.dataDir, tmuxSession, claudeSessionId);
      res.json({ saved });
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions/:id/resume', async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      if (!isValidSlug(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

      const meta = getMeta(config.dataDir, sessionId);
      const body = req.body ?? {};

      // Not "is there an accountId" but "does it still resolve": deleting
      // an account leaves the stored id pointing nowhere, and the session
      // must still be able to take the id the frontend sends - otherwise
      // that chat stays unreachable.
      const storedIsValid = Boolean(meta?.accountId)
        && Boolean(getAccountById(config.accountsSecretPath, meta.accountId));

      // Sessions from the JSONL history were never started via Claudux and
      // therefore have no meta entry. Without this fallback, every click on
      // an existing session would fail with 404. The sidebar knows
      // projectId and - if resumed via Claudux once before - also the
      // accountId, and sends both along in the body.
      const projectId = meta?.projectId ?? body.projectId;
      let accountId = storedIsValid ? meta.accountId : body.accountId;
      if (!accountId) {
        const accounts = listAccounts(config.accountsSecretPath);
        if (accounts.length === 1) {
          accountId = accounts[0].id;
        } else if (accounts.length > 1) {
          return res.status(400).json({
            error: 'Multiple accounts exist - please specify accountId in the request body.',
          });
        }
        // 0 accounts: accountId stays undefined and falls through into the
        // regular "unknown account" 400 below.
      }
      // Whenever the stored assignment didn't win, it has to be written -
      // that's how an entry without one heals.
      const metaNeedsAccount = !meta || !storedIsValid;

      const project = loadProjects(projectsConfigPath).find((p) => p.id === projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const token = getTokenById(config.accountsSecretPath, accountId);
      if (!token) return res.status(400).json({ error: `Unknown account: ${accountId}` });

      // A corpse is not a running session: with remain-on-exit a crashed
      // `claude` leaves the tmux session listed, and attaching to it is a
      // dead end. Reap it here and fall through to the regular resume.
      //
      // One snapshot serves both this lookup and the carrier lookup further
      // down: the kill below only ever targets sessionId, never carrier, so
      // the carrier's entry in this snapshot is still accurate at that point.
      const sessions = await listTmuxSessions();
      const corpse = sessions.find((s) => s.name === sessionId && s.dead);
      let restoredAfterCrash;
      if (corpse) {
        if (isUnwantedDeath(corpse)) {
          restoredAfterCrash = { status: corpse.deadStatus, signal: corpse.deadSignal };
          // The last lines before the crash are the only diagnosis there
          // is, and the kill below drops them.
          const tail = (await capturePane(sessionId)).trimEnd().split('\n').slice(-20).join('\n');
          console.error(`Session ${sessionId} crashed (status ${corpse.deadStatus}, signal ${corpse.deadSignal}). Last lines:\n${tail}`);
        }
        // Awaited, not fire-and-forget: with the name still taken,
        // `new-session` fails, the wrapper never runs, and the token file
        // stays on disk - the leak the comment below is about.
        await killSession(sessionId).catch(() => {});
      }

      // If the session is already running, there's nothing to start - it
      // just needs to be reopened.
      //
      // Without this branch, a token leak occurs: `tmux new-session`
      // fails on the name already being taken, the wrapper script never
      // gets to run and doesn't delete the token file. The cleanup branch
      // below doesn't catch it either, because waitForSession finds the
      // running session and reports success - a token would be left on
      // disk on every open.
      //
      // The meta entry is still updated regardless, otherwise a session
      // without meta would lose its account assignment just because it
      // happened to be running.
      if (await hasSession(sessionId)) {
        if (metaNeedsAccount) setMeta(config.dataDir, sessionId, { ...(meta ?? {}), accountId, projectId: project.id });
        // restoredAfterCrash can be set here too: the killSession() above is
        // caught, not guaranteed, so a corpse that resisted reaping can
        // still leave hasSession() true - the diagnosis from the block
        // above must still reach the response.
        return res.json({ id: sessionId, terminalUrl: `/ttyd/?arg=${sessionId}`, ...(restoredAfterCrash ? { restoredAfterCrash } : {}) });
      }

      // No tmux session is running under its OWN name - but it may be
      // running under a different one: after a `/clear`, Claude Code
      // assigns a new session ID and writes a new JSONL, while the tmux
      // session keeps its old name. The sidebar lists the JSONLs, so it
      // shows the new ID as an ended session. Without this branch, a
      // click on it would start a SECOND tmux session while the first one
      // still holds the same conversation open - two processes would then
      // write into the same JSONL.
      //
      // The mapping comes from the session registry, not from a
      // measurement of the files: the JSONL carries no back-reference, the
      // `claude` process doesn't keep it open, and `parentUuid` never
      // points into another file.
      const carrier = meta?.tmuxSession;
      if (carrier && carrier !== sessionId && isValidSlug(carrier) && (await hasSession(carrier))) {
        // A dead carrier is no carrier: attaching would be the same dead end
        // as above, and after a /clear this is the branch a crash lands in.
        const carrierEntry = sessions.find((s) => s.name === carrier);
        if (carrierEntry?.dead) {
          if (isUnwantedDeath(carrierEntry)) {
            restoredAfterCrash = { status: carrierEntry.deadStatus, signal: carrierEntry.deadSignal };
            const tail = (await capturePane(carrier)).trimEnd().split('\n').slice(-20).join('\n');
            console.error(`Session ${carrier} crashed (status ${carrierEntry.deadStatus}, signal ${carrierEntry.deadSignal}). Last lines:\n${tail}`);
          }
          await killSession(carrier).catch(() => {});
        } else {
          // restoredAfterCrash may already be set: sessionId's OWN corpse
          // (reaped above) and a live carrier for a DIFFERENT conversation
          // both apply to the same meta entry after reconcile() - the
          // diagnosis from that reap must not be dropped just because the
          // carrier is still around.
          return res.json({ id: sessionId, terminalUrl: `/ttyd/?arg=${carrier}`, ...(restoredAfterCrash ? { restoredAfterCrash } : {}) });
        }
      }

      // Token via a 0600 file instead of in argv - see the create route
      // above.
      const tokenFilePath = writeSessionTokenFile(config.dataDir, sessionId, token);
      // Same placement and reasoning as the create route above.
      ensureOnboardingCompleted();
      const args = buildNewSessionArgs({ sessionId, projectPath: project.path, tokenFilePath, resume: true });
      spawnTmux(args);
      const started = await waitForSession(sessionId);
      // Only on failure - otherwise a race with the wrapper, see the
      // create route.
      if (!started) removeSessionTokenFile(config.dataDir, sessionId);
      await disableStatusBar(sessionId);
      // Same placement and reasoning as the create route above.
      await setRemainOnExit(sessionId);

      // From here on the session carries itself again: the carrier branch
      // above didn't apply, so the old tmux session no longer exists. If
      // the `tmuxSession` reference stayed in place, the sidebar would
      // keep looking for the live dot under the dead carrier - a running
      // session would then sit in the list without a green dot.
      // `currentSession` is dropped for the same reason: this session's
      // conversation is its own again.
      if (metaNeedsAccount || meta?.tmuxSession || meta?.currentSession) {
        // Only write back AFTER a successful resume, so future resumes
        // take the known meta path again. Only when needed:
        // session-meta.json is a non-atomic read-modify-write, writing on
        // EVERY click would be unnecessary load on it.
        const updated = { ...(meta ?? {}), accountId, projectId: project.id };
        delete updated.tmuxSession;
        delete updated.currentSession;
        setMeta(config.dataDir, sessionId, updated);
      }

      res.json({ id: sessionId, terminalUrl: `/ttyd/?arg=${sessionId}`, restarted: true, ...(restoredAfterCrash ? { restoredAfterCrash } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // End a session by hand. Ends the tmux session, NOT the history: the
  // JSONL stays in place, the same conversation can be resumed afterward.
  // That's also why the meta entry stays - it carries the account
  // assignment needed when resuming.
  //
  // No `next`: the only possible error is deliberately turned into a
  // success below, there's nothing to pass on.
  router.delete('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSlug(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      // Via the carrier, because after a /clear the row with the end
      // button carries the new Claude ID - no tmux session runs under
      // that. Without this resolution, ending would report success
      // without ending anything.
      await killSession(tmuxSessionFor(config.dataDir, sessionId));
      res.status(204).end();
    } catch {
      // killSession throws if the session no longer exists. It may have
      // ended between display and click - then the goal is already
      // reached, and an error would be misleading.
      res.status(204).end();
    }
  });

  // Changes properties of a session. Merging instead of replacing:
  // setMeta rewrites the entry completely, an incomplete object would
  // silently delete the remaining fields - including the account
  // assignment that resuming depends on.
  //
  //   protected - protects from the idle reaper.
  //   accountId - which account to resume under. The resume route takes the
  //     stored value if it still resolves, and only falls back to one sent
  //     along otherwise - so resuming doesn't accidentally switch the
  //     subscription, but a deleted account doesn't strand the chat either.
  router.patch('/sessions/:id', (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSlug(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const { protected: isProtected, accountId } = req.body ?? {};

    // An unknown account would only surface on the next resume - by then
    // the connection to this change is long gone.
    if (accountId !== undefined && !getAccountById(config.accountsSecretPath, accountId)) {
      return res.status(400).json({ error: `Unknown account: ${accountId}` });
    }

    const existing = getMeta(config.dataDir, sessionId) ?? {};
    const updated = { ...existing };
    if (isProtected !== undefined) updated.protected = Boolean(isProtected);
    if (accountId !== undefined) updated.accountId = accountId;
    setMeta(config.dataDir, sessionId, updated);

    res.json(updated);
  });

  // Passes the tmux buffer to the frontend, which writes it to the
  // clipboard (background in showBuffer() in tmuxManager.js). Deliberately
  // NO :id in the path: buffers are server-global, a session reference
  // would be wrong.
  router.get('/tmux-buffer', async (req, res) => {
    try {
      const text = await showBuffer();
      res.json({ text });
    } catch {
      // showBuffer() throws if nothing has ever been copied server-wide -
      // a normal state, not a server error.
      res.status(404).json({ error: 'No tmux buffer available - copy something in the terminal first.' });
    }
  });

  // Text view for selecting on the phone: there's no way into tmux's copy
  // mode there (mouse mode off, alternate screen with no scrollback,
  // finger-drag scrolls), so the pane content comes into the UI as text.
  //
  // Unlike /tmux-buffer, this is genuinely session-scoped - hence :id.
  // Both versions in one response: a terminal screen is a few kilobytes,
  // and in return the view switches without a second request.
  router.get('/sessions/:id/pane', async (req, res, next) => {
    try {
      if (!isValidSlug(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
      // capturePane() returns an empty string instead of throwing for an
      // ended session (see there) - without this check, "session gone"
      // couldn't be told apart from "pane empty".
      if (!(await hasSession(req.params.id))) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const raw = await capturePane(req.params.id);
      res.json({ raw, clean: sanitizePaneText(raw) });
    } catch (err) {
      next(err);
    }
  });

  // One subagent's own conversation, for the window that shows it. `after`
  // is the offset a previous answer returned, so a window that is already
  // open fetches only what has been written since - a transcript that runs
  // to tens of kilobytes is not re-sent on every tool call.
  router.get('/sessions/:id/agents/:agentId', (req, res, next) => {
    try {
      const { id, agentId } = req.params;
      // The id goes into a path.join below, so it is held to the same
      // whitelist that matches an agent's meta file in subagentWatcher.js.
      if (!AGENT_ID_RE.test(agentId)) {
        res.status(400).json({ error: 'Unusable agent id' });
        return;
      }
      if (!getMeta(config.dataDir, id)) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      const transcript = chooseTranscript(config.claudeHome, claudeSessionIdsForTmux(config.dataDir, id));
      const dir = subagentsDirFor(transcript);
      const agentPath = dir ? path.join(dir, `agent-${agentId}.jsonl`) : null;
      if (!agentPath || !fs.existsSync(agentPath)) {
        res.status(404).json({ error: 'Unknown agent' });
        return;
      }
      const after = Number.parseInt(req.query.after ?? '0', 10);
      res.json(readAgentBlocks(agentPath, Number.isFinite(after) && after > 0 ? after : 0));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
