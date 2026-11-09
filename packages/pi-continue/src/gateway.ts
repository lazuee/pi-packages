/**
 * The session gateway: which sessions pi-continue may act in.
 *
 * Modules do not travel between sessions — every session, and every in-process
 * subagent child, loads its own copy of this extension. The gateway is therefore
 * *local knowledge*: in-process children register themselves synchronously, on
 * their own copy, before anything here could ask. An out-of-process child cannot
 * reach another process's memory, so its copy falls back to the
 * `PI_CONTINUE_FOR_CHILD` stamp its spawner leaves in the environment.
 */

/** The marker an out-of-process spawner sets for the child it launches. */
export const CHILD_STAMP_ENV = "PI_CONTINUE_FOR_CHILD";

/**
 * Root markers an unrecognised session falls back to when no parent session is
 * configured. Grandfathered per the permission-system's subagent convention.
 */
const ROOT_STAMP_ENVS = [
  "PI_SUBAGENT_CHILD",
  "PI_IS_SUBAGENT",
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
];

/** Where this session sits in a delegation tree. */
export interface SessionPosition {
  /** The gateway's answer, or `undefined` to leave it open. */
  stamp: boolean | undefined;
  /** Seconds since the last lifecycle event in any run, or `Infinity`. */
  msSinceLastActivity?: number;
  /** Whether this session's own load is driven by a live subagent run. */
  driven?: boolean;
  /** Whether the session attended, by any means other than the stamp. */
  attended?: boolean;
}

export class SessionGateway {
  #isChild = false;
  /** Sessions this one delegates to and must not talk over. */
  readonly #children = new Set<string>();
  #driven = false;
  #lastActivityAt = 0;

  /** This session is an in-process subagent child. */
  markChild(): void {
    this.#isChild = true;
  }

  /** A child run started; hold recoveries until it ends. */
  childSpawned(childId: string): void {
    if (childId) this.#children.add(childId);
    this.touch();
  }

  /** A child run ended; forget it whichever way it ended. */
  childFinished(childId: string): void {
    if (childId) this.#children.delete(childId);
    this.touch();
  }

  /** A run started in this session, from a prompt or from a recovery. */
  runStarted(): void {
    this.#driven = true;
    this.touch();
  }

  /** A turn ended; the run itself may still be open. */
  turnEnded(): void {
    this.touch();
  }

  /** Whether a subagent child of this session is still running. */
  get hasActiveChildren(): boolean {
    return this.#children.size > 0;
  }

  /** Milliseconds since this session last saw any lifecycle activity. */
  msSinceActivity(now: number): number {
    return this.#lastActivityAt === 0
      ? Number.POSITIVE_INFINITY
      : now - this.#lastActivityAt;
  }

  /** Record activity now, so an idle gap is measured from the last real event. */
  touch(now = Date.now()): void {
    this.#lastActivityAt = now;
  }

  /** Whether a run is open in this session right now. */
  isDriven(): boolean {
    return this.#driven;
  }

  /** Whether this session is known to be a subagent child. */
  get isChild(): boolean {
    return this.#isChild;
  }

  /**
   * Whether pi-continue may act in this session.
   *
   * An explicit stamp wins. Otherwise the answer is inferred: a child with no
   * stamp is still a child (the marker set is only a hint), a session with live
   * children is a root that must not talk over them, and a session that saw a
   * run it did not hear a child for is a root whose run has ended.
   */
  isGatedIn(config: {
    continueSelf: boolean;
    continueChildren: boolean;
  }): boolean {
    if (this.#isChild) return config.continueChildren;
    return config.continueSelf;
  }
}

/** Read one environment variable without throwing on a missing `process`. */
export function readEnv(
  name: string,
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  return env?.[name];
}

/**
 * Decide the gateway from the environment, for the case where no lifecycle event
 * will ever arrive.
 *
 * `undefine` means "no opinion", which leaves the gateway at its lifecycle-driven
 * answer; only the presence of {@link CHILD_STAMP_ENV} is decided here, because a
 * parent is the one thing an out-of-process child cannot learn any other way.
 */
export function stampedFromEnv(
  env: Record<string, string | undefined> | undefined,
): boolean | undefined {
  if (readEnv(CHILD_STAMP_ENV, env) === "1") return true;
  return undefined;
}

/**
 * Whether any root marker says this process is a subagent. Used only to keep the
 * child stamp from being silently satisfied in a process that is plainly a root.
 */
export function looksLikeRootMarker(
  env: Record<string, string | undefined> | undefined,
): boolean {
  return ROOT_STAMP_ENVS.some((name) => {
    const value = readEnv(name, env);
    return (
      value !== undefined && value !== "" && value !== "0" && value !== "false"
    );
  });
}
