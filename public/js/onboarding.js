// The onboarding wizard: three steps (account, project, first session) shown
// over the empty terminal area until all three are done. Purely derived from
// state the caller already has - no server round-trip, no localStorage. See
// docs/superpowers/specs/2026-08-18-claudux-einstiegsassistent-design.md for
// why a persisted "seen" flag isn't needed: a project's sessions stay listed
// (as a gray-dot corpse) until the project itself is removed, the reaper
// never deletes the JSONL that keeps them there.
import { onboardingWizardEl, tabTerminalEl } from './dom.js';

let openManagement = () => {};

export function initOnboarding(deps) {
  openManagement = deps.openManagement;
}

const stepEls = {
  account: document.querySelector('.onboarding-step[data-step="account"]'),
  project: document.querySelector('.onboarding-step[data-step="project"]'),
  chat: document.querySelector('.onboarding-step[data-step="chat"]'),
};

// Mirrors setStepActive() in loginWizard.js: `disabled` in addition to
// dimming, so a locked step's button isn't reachable by keyboard either.
function setStep(step, active, done) {
  const el = stepEls[step];
  el.dataset.activeEntry = String(active);
  el.dataset.done = String(done);
  el.querySelectorAll('button').forEach((btn) => { btn.disabled = !active; });
}

// Called from render(), and from the two tab-switch functions in app.js -
// switching to the Files tab must hide this immediately, not just on the
// next data change, and switching back must re-evaluate against the
// current data rather than staying hidden.
//
// Fully live-derived on purpose, including hasAccount: deleting the
// account again after the wizard was already dismissed brings it back
// with step 1 active, rather than staying hidden forever - there is no
// "seen it" flag to consult instead.
export function updateOnboardingWizard(accounts, projects) {
  const hasAccount = accounts.length > 0;
  const hasProject = projects.length > 0;
  const hasSession = projects.some((p) => p.sessions.length > 0);

  setStep('account', true, hasAccount);
  setStep('project', hasAccount, hasProject);
  setStep('chat', hasProject, hasSession);

  const allDone = hasAccount && hasProject && hasSession;
  onboardingWizardEl.hidden = allDone || tabTerminalEl.dataset.active !== 'true';
}

document.getElementById('onboardingAddAccount').addEventListener('click', () => openManagement('accounts'));
document.getElementById('onboardingAddProject').addEventListener('click', () => openManagement('projects'));
