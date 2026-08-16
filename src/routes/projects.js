import express from 'express';
import path from 'node:path';
import {
  loadProjects, addProject, toggleFavorite, removeProject, setDefaultAccountId,
  setNotifyLevel, NOTIFY_LEVELS,
} from '../lib/projectStore.js';
import { listSessions } from '../lib/sessionStore.js';
import { buildSessionList } from '../lib/sessionList.js';
import { getMeta, tmuxSessionFor, currentConversationFor } from '../lib/sessionMeta.js';
import {
  listTmuxSessions, capturePane, isUnwantedDeath, isSafeProjectPath,
} from '../lib/tmuxManager.js';
import { readRegistry, reconcile } from '../lib/sessionRegistry.js';
import { resolveActiveAccounts } from '../lib/activeAccount.js';
import { detectAuthProblem } from '../lib/authStatus.js';
import { accountIdForToken } from '../lib/accountStore.js';

export function projectsRouter(config) {
  const router = express.Router();
  const configPath = path.join(config.dataDir, 'projects.json');

  router.get('/', (req, res) => {
    res.json({ projects: loadProjects(configPath) });
  });

  router.post('/', (req, res) => {
    const { name, projectPath } = req.body ?? {};
    // Typed, not just truthy: an object here reached fs.mkdirSync and came
    // back as a 500 with raw Node text in it.
    if (typeof name !== 'string' || name.trim() === ''
        || typeof projectPath !== 'string' || projectPath.trim() === '') {
      return res.status(400).json({ error: 'name and projectPath are required' });
    }
    // Rejected here rather than at session start, where the same check
    // would surface as a 500 on the first attempt to use the project.
    if (!isSafeProjectPath(projectPath)) {
      return res.status(400).json({ error: 'projectPath must be absolute and must not contain "#"' });
    }
    const project = addProject(configPath, { name, projectPath });
    res.status(201).json(project);
  });

  router.post('/:id/favorite', (req, res) => {
    const exists = loadProjects(configPath).some((p) => p.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Project not found' });
    toggleFavorite(configPath, req.params.id);
    res.status(204).end();
  });

  // A partial patch: every known field is optional, only what arrives gets
  // checked. For defaultAccountId, `undefined` and `null` are still NOT the
  // same: null explicitly clears the default, absent means "not part of
  // this call" - without the distinction, "clear" couldn't be told apart
  // from "forgot".
  //
  // Everything is validated before the first write: a call carrying one
  // good and one bad field must not leave the good half applied.
  //
  // Only types are checked, not whether the account exists: the assignment
  // is a UI preset, not a guarantee, and an account removed in the meantime
  // wouldn't reach this route anyway.
  router.patch('/:id', (req, res) => {
    const exists = loadProjects(configPath).some((p) => p.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Project not found' });
    const { defaultAccountId, notify } = req.body ?? {};
    if (defaultAccountId === undefined && notify === undefined) {
      return res.status(400).json({ error: 'defaultAccountId or notify is required' });
    }
    if (defaultAccountId !== undefined && defaultAccountId !== null && typeof defaultAccountId !== 'string') {
      return res.status(400).json({ error: 'defaultAccountId must be a string or null' });
    }
    if (notify !== undefined && !NOTIFY_LEVELS.includes(notify)) {
      return res.status(400).json({ error: `notify must be one of ${NOTIFY_LEVELS.join(', ')}` });
    }
    if (defaultAccountId !== undefined) setDefaultAccountId(configPath, req.params.id, defaultAccountId);
    if (notify !== undefined) setNotifyLevel(configPath, req.params.id, notify);
    res.status(204).end();
  });

  // Only removes the list entry (see removeProject) - neither the actual
  // files nor the session history are touched, the project can be added
  // again at any time via the same path.
  router.delete('/:id', (req, res) => {
    const exists = loadProjects(configPath).some((p) => p.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Project not found' });
    removeProject(configPath, req.params.id);
    res.status(204).end();
  });

  router.get('/:id/sessions', async (req, res, next) => {
    try {
      const project = loadProjects(configPath).find((p) => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      // A single `list-sessions` call for all sessions instead of one
      // `has-session` call per row.
      const running = await listTmuxSessions();
      // Before the list is built: which conversation is each carrier running
      // right now? The registry answers that for live processes, and the
      // reconcile writes it where the ended ones are resolved from later.
      //
      // Here rather than on a timer of its own - `running` is already
      // available, and the list is the only consumer that needs it fresh.
      const registry = readRegistry(config.claudeHome);
      reconcile(config.dataDir, registry, running.map((s) => s.name));
      // A corpse is an ended session for the list: with a JSONL row it
      // keeps the gray dot, without one it has no row at all (placeholders
      // come from this filtered `alive`). Not for reconcile above, though -
      // a crash within the two seconds after a /clear would otherwise never
      // store the pairing, and the carrier branch in sessions.js would
      // start a SECOND process on the same JSONL.
      const alive = running.filter((s) => !s.dead);
      // For the `crashed` flag below - keyed on the UNFILTERED list, since
      // that's the only one still carrying the corpses.
      const runningByName = new Map(running.map((s) => [s.name, s]));
      // The CLI's four status values collapse into the two the dot knows:
      // it is either producing something or it is not. A carrier with no
      // registry entry gets null - the row then shows the plain live dot
      // instead of a state nobody measured.
      const activityFor = (carrier) => {
        const status = registry.get(carrier)?.status;
        if (!status) return null;
        return status === 'busy' ? 'working' : 'waiting';
      };
      // Which tmux session carries this conversation? After a /clear
      // that's not its own ID. Everything tied to the running process -
      // the live dot, the account, the auth check - must go through the
      // carrier, otherwise a continued session looks like an ended one.
      const carrierFor = (id) => tmuxSessionFor(config.dataDir, id);
      // `accountId` is the stored ASSIGNMENT, `activeAccountId` the account
      // the process ACTUALLY runs under. Both are delivered separately: for
      // ended sessions there's no process, so only the assignment remains;
      // for running ones the environment is the truth.
      const active = await resolveActiveAccounts((token) =>
        accountIdForToken(config.accountsSecretPath, token),
      );
      // Auth check here instead of behind its own route per session: the
      // point is precisely to notice an expired login WITHOUT opening the
      // session.
      //
      // Only running sessions. In parallel, so the list doesn't come
      // noticeably later with several sessions; one that has ended in the
      // meantime returns an empty string and thus "no problem".
      const ownSessions = buildSessionList({
        history: listSessions(config.claudeHome, project.path),
        running: alive,
        projectId: project.id,
        metaFor: (id) => getMeta(config.dataDir, id),
        carrierFor,
        conversationFor: (carrier) => currentConversationFor(config.dataDir, carrier),
        activityFor,
      });
      const authProblems = new Map(
        await Promise.all(
          ownSessions
            .filter((s) => s.live)
            .map(async (s) => [s.id, detectAuthProblem(await capturePane(carrierFor(s.id)))]),
        ),
      );
      const sessions = ownSessions.map((s) => {
        const carrier = carrierFor(s.id);
        const carrierEntry = runningByName.get(carrier);
        const activeEntry = active.get(carrier);
        const meta = getMeta(config.dataDir, s.id);
        return {
          ...s,
          // True only for a corpse the user did NOT mean to leave (see
          // isUnwantedDeath) - a clean `/exit` must never trigger the
          // frontend's auto-heal on the next list tick.
          crashed: isUnwantedDeath(carrierEntry),
          // The other side of the same corpse: true only when the carrier
          // is dead AND the death was wanted (`/exit`, Ctrl+D). A carrier
          // that's merely gone - reaped, ended elsewhere, not started yet -
          // is neither `crashed` nor `cleanExit`, since "gone" can't be
          // told apart from "starting".
          cleanExit: carrierEntry?.dead === true && !isUnwantedDeath(carrierEntry),
          // Protection from the idle reaper. Must be in the list, otherwise
          // the UI can't show the state.
          protected: meta?.protected === true,
          // null means "no problem detected" OR "not checkable because
          // ended" - deliberately not distinguished, there's nothing to
          // show for an ended session.
          authProblem: authProblems.get(s.id) ?? null,
          accountId: meta?.accountId || null,
          activeAccountId: activeEntry?.accountId ?? null,
          // If the session runs without a token, it can only run via
          // another auth source - which no longer exists at all since
          // .credentials.json was removed. A separate warning state for
          // the UI, not "no account".
          hasToken: activeEntry?.hasToken ?? null,
        };
      });
      res.json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
