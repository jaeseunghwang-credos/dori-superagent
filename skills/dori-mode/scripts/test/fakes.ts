import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string | Record<string, string>;
  dirty: string | Record<string, string>;
  /** `git worktree list --porcelain` output; defaults to a cwd plus one lane-owned worktree. */
  worktreeList?: string;
  /** `git rev-parse --is-inside-work-tree` answer; a lane whose cwd is not a checkout gets "false". */
  isGitRepo?: string;
  stuckReads: number;
  screen: string;
  panes: { pane_id: string; workspace_id: string; agent?: string; agent_status?: string; title?: string; cwd?: string }[];
  /** agent_status the target pane moves to when Enter is pressed (models a lane picking up the message). */
  onEnterStatus?: string;
  /** Screens returned by successive reads; falls back to `screen` when empty. */
  screens?: string[];
  calls: string[][];
};

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", panes: [], calls: [] });

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "herdr" && a1 === "pane" && a2 === "read") {
    if (w.stuckReads > 0) {
      w.stuckReads--;
      return ok("❯ [LEAD] stuck text still here");
    }
    return ok(w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen);
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && w.onEnterStatus) {
    const p = w.panes.find((x) => x.pane_id === argv[3]);
    if (p) p.agent_status = w.onEnterStatus;
    return ok();
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  if (cmd === "herdr") return ok();
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) return ok(w.worktreeList ?? `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`);
  if (cmd === "git" && argv.includes("rev-parse") && argv.includes("--is-inside-work-tree")) return ok(w.isGitRepo ?? "true");
  // Outside a readable checkout, git status and rev-list fail as real git does (exit 128).
  if (cmd === "git" && w.isGitRepo === "false" && (argv.includes("status") || argv.includes("rev-list"))) return { code: 128, out: "", err: "fatal: not a git repository" };
  if (cmd === "git" && argv.includes("status")) return ok(typeof w.dirty === "string" ? w.dirty : (w.dirty[argv[2] ?? ""] ?? ""));
  if (cmd === "git" && argv.includes("rev-list")) return ok(typeof w.aheadCount === "string" ? w.aheadCount : (w.aheadCount[argv[2] ?? ""] ?? "0"));
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, defaultCwd: "/repo", leadPane: "lead:p1", ...patch };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: () => true };
};

export const sent = (w: World): string[] => w.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text").map((c) => c[4] ?? "");
