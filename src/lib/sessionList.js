// The sidebar list of a project comes from TWO sources that don't line up:
// the JSONL files from Claude Code (title, history) and the running tmux
// sessions (what's alive right now). A freshly started session only shows
// up in the second one - Claude Code doesn't create its file until the
// first prompt. Anyone reading only the history therefore doesn't see the
// session that was just started.
//
// Pure and filesystem-free: the two lookup functions come in from outside,
// so the merge stays testable without a tmux server and without test
// fixtures.

const PLACEHOLDER_TITLE = '(no prompt yet)';

// activityFor answers "what is this carrier doing right now" for the FIRST
// render. Without it a live row starts as the plain pulsing dot and the
// status stream only corrects it on the next change - so a session that has
// been waiting a while would pulse again after every list rebuild.
export function buildSessionList({
  history, running, projectId, metaFor, carrierFor, conversationFor, activityFor = () => null,
}) {
  const runningNames = new Set(running.map((s) => s.name));

  // Per carrier, the most recently started of its rows - the fallback for
  // when there's no report (see currentConversation).
  const latestPerCarrier = new Map();
  for (const entry of history) {
    const carrier = carrierFor(entry.id);
    const previous = latestPerCarrier.get(carrier);
    if (!previous || entry.startMs > previous.startMs) latestPerCarrier.set(carrier, entry);
  }

  // Which of its conversations is this carrier currently running? First the
  // pairing from Claude Code's session registry; it's the only reliable
  // source.
  //
  // Without a report, the most recently started one: existing data from
  // before this report existed doesn't carry the marker, and without a
  // fallback all of its sessions continued after a /clear counted as
  // finished. A /clear always starts a newer file than the one it clears -
  // so the ordering gets it right, even though it doesn't prove it.
  function currentConversation(carrier) {
    const reported = conversationFor(carrier);
    if (reported !== carrier) return reported;
    return latestPerCarrier.get(carrier)?.id ?? carrier;
  }

  const withLive = history.map((entry) => {
    // Via the carrier session rather than its own ID: after a /clear, Claude
    // Code assigns a new ID, but the tmux session keeps its name.
    const carrier = carrierFor(entry.id);
    // After several /clear a carrier is running several of the list's
    // conversations, but only ONE of them right now. The rest have ended,
    // even if their tmux session keeps running.
    const current = currentConversation(carrier) === entry.id;
    const live = current && runningNames.has(carrier);
    return { ...entry, carrier, current, live, activity: live ? activityFor(carrier) ?? null : null };
  });

  const inHistory = new Set(history.map((e) => e.id));

  const placeholders = running
    // listTmuxSessions sees the whole tmux server: sessions belonging to
    // other projects (or none) have to be filtered out here.
    .filter((s) => metaFor(s.name)?.projectId === projectId)
    // The placeholder stands for the conversation the tmux session is
    // CURRENTLY running - after a /clear that's no longer its own name.
    // Between the /clear and the first prompt after it, this conversation
    // already exists but its file doesn't yet; without its own row, no row
    // carries the green dot during that time.
    .map((s) => ({ tmux: s, conversation: currentConversation(s.name) }))
    // Once the file exists, the history row carries the same state - a
    // second row next to it would be the same session twice.
    .filter(({ conversation }) => !inHistory.has(conversation))
    .map(({ tmux: s, conversation }) => ({
      id: conversation,
      title: PLACEHOLDER_TITLE,
      lastPrompt: null,
      carrier: s.name,
      current: true,
      // Without a file there's no file time; the tmux start time is the more
      // accurate value here, since it means the process start rather than
      // the first prompt. Seconds, hence times a thousand.
      startMs: s.createdEpoch ? s.createdEpoch * 1000 : 0,
      mtimeMs: s.createdEpoch ? s.createdEpoch * 1000 : 0,
      live: true,
      activity: activityFor(s.name) ?? null,
    }));

  return [...withLive, ...placeholders].sort((a, b) => b.startMs - a.startMs);
}
