/**
 * Session-level loop mode.
 *
 * Before this existed, "am I looping?" lived only in `loopTurnActive`, a flag
 * cleared on every `agent_end` and re-earned by the next tool call. Any slash
 * command cleared it too, so `/multiloop status` silently stalled a running
 * loop, and a new session never resumed one at all.
 *
 * Loop mode is the durable half of that answer: set when a loop starts or
 * resumes, armed again at session start when a running loop is on disk, and
 * cleared only by an explicit stop/pause/off. `loopTurnActive` keeps its
 * separate job — preventing a chat-only turn from re-prompting itself forever.
 *
 * Every decision here is pure so it can be tested without the extension
 * runtime, which is where this package has historically hidden its defects.
 */

export const MODE_ENTRY_TYPE = "multiloop-mode";

export interface ModeEntryData {
  version: 1;
  cwd: string;
  active: boolean;
}

/** Session entries carry `data` as unknown; narrow it without trusting it. */
export interface ModeEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export type UserInputVerdict = "suspend" | "arm" | "neutral";

/** Verbs that read as a request to halt work. */
const STOP_VERB = String.raw`stop|pause|halt|suspend`;
/** Nouns that mean this loop, rather than some other kind of work. */
const LOOP_NOUN = String.raw`loop|multiloop|iteration`;

const SUSPEND_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(${STOP_VERB})\b[^.?!]*\b(${LOOP_NOUN})\b`),
  new RegExp(String.raw`\b(${LOOP_NOUN})\b[^.?!]*\b(${STOP_VERB})\b`),
  /\b(do not|don't|dont)\s+continue\b/,
];

/** A negated stop is not a request to stop: "should not stop until tests pass". */
const NEGATED_STOP = new RegExp(
  String.raw`\b(not|never|dont|don't|doesn't|shouldn't|wont|won't)\b[^.?!]*\b(${STOP_VERB})\b`
);

function isSuspendRequest(lower: string): boolean {
  // A question about the loop asks for information, not a halt.
  if (lower.endsWith("?")) return false;
  if (NEGATED_STOP.test(lower)) return false;
  return SUSPEND_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Decide what a user message does to loop mode.
 *
 * Slash commands are always neutral. Their handlers own loop semantics --
 * including the lane-scoped stop/pause that must not disturb sibling lanes --
 * so classifying "/multiloop stop perf" as a suspend here would apply a
 * session-global disarm on top of a deliberately lane-scoped operation and kill
 * every other lane on the worktree.
 *
 * Only natural language can suspend, and only when it reads as a request:
 * questions and negations are excluded, and the verb list stays narrow because
 * "remove"/"archive"/"delete" are overwhelmingly about code, not the loop.
 */
export function classifyUserInput(text: string): UserInputVerdict {
  const trimmed = text.trim();
  if (!trimmed) return "neutral";
  if (trimmed.startsWith("/")) return "neutral";
  return isSuspendRequest(trimmed.toLowerCase()) ? "suspend" : "arm";
}

/**
 * Reduce recorded session entries to the most recent mode decision for a cwd,
 * or null when the user never decided in this session.
 *
 * Replaying from the session branch is what lets an explicit stop survive
 * `/tree`, compaction, and reloads instead of snapping back on.
 */
export function latestModeDecision(entries: readonly ModeEntryLike[], cwd: string): boolean | null {
  let decision: boolean | null = null;

  for (const entry of entries) {
    if (entry.customType !== MODE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<ModeEntryData> | undefined;
    if (typeof data?.cwd !== "string" || typeof data.active !== "boolean") continue;
    if (data.cwd !== cwd) continue;
    decision = data.active;
  }

  return decision;
}

export interface ArmModeInput {
  /** A loop with status "running" exists under this cwd's .multiloop/. */
  hasRunningLoopOnDisk: boolean;
  /** Most recent explicit decision in this session, or null if none. */
  recordedDecision: boolean | null;
}

/**
 * Decide whether to arm loop mode at session start.
 *
 * A running loop on disk implies intent: the previous session did not stop it.
 * An explicit decision recorded in this session always wins, so a user who
 * turned the loop off does not get it back by reloading.
 */
export function shouldArmLoopMode(input: ArmModeInput): boolean {
  if (input.recordedDecision !== null) return input.recordedDecision;
  return input.hasRunningLoopOnDisk;
}

export interface ContinuationInput {
  /** Session-level intent to keep looping. */
  loopMode: boolean;
  /** A loop tool ran this turn, or the user said something loop-continuing. */
  loopTurnActive: boolean;
  /** At least one attached loop still has status "running". */
  hasRunningStates: boolean;
}

/**
 * Decide whether `agent_end` should queue the next loop action.
 *
 * All three must hold. Mode alone is not enough: a chat-only turn would
 * otherwise re-prompt itself forever, which is the failure the per-turn flag
 * exists to prevent.
 */
export function shouldQueueContinuation(input: ContinuationInput): boolean {
  return input.loopMode && input.loopTurnActive && input.hasRunningStates;
}

/**
 * Whether a lane-scoped stop/pause should also clear session loop mode.
 *
 * Loop mode is a session-level fact — "is anything looping here?" — while
 * stop/pause act on one lane. Clearing it unconditionally meant pausing one
 * lane silently stopped every other lane on the worktree, and the recorded
 * decision then survived reload, so a fresh session refused to arm even with
 * loops still running.
 *
 * An explicit `/multiloop off` or a "stop the loop" message is different: the
 * user is addressing the session, so those still force mode off directly.
 */
export function shouldDisarmAfterLaneOperation(remainingRunningLoops: number): boolean {
  return remainingRunningLoops === 0;
}
