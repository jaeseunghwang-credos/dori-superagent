// Thin, typed wrapper over the herdr CLI. Every call goes through one injectable `Exec`,
// so tests can replace herdr with a recorder and the e2e test can point at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (cmd: string, argv: readonly string[]) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv) => {
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class HerdrError extends Error {
  constructor(readonly argv: readonly string[], readonly result: ExecResult) {
    super(`herdr ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

/** Agent lifecycle as herdr reports it. `shell` = no recognised agent in the pane. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

export type PaneRef = { readonly paneId: string; readonly tabId: string; readonly workspaceId: string };

export class Herdr {
  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly session: string | undefined = process.env["DORI_HERDR_SESSION"],
  ) {}

  private async call(argv: readonly string[]): Promise<Record<string, unknown>> {
    const full = this.session ? ["--session", this.session, ...argv] : [...argv];
    const res = await this.exec("herdr", full);
    if (res.code !== 0) throw new HerdrError(full, res);
    const text = res.stdout.trim();
    if (!text.startsWith("{")) return {};
    const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  }

  async createWorkspace(label: string, cwd: string): Promise<PaneRef> {
    const r = await this.call(["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
    return toPaneRef(r["root_pane"]);
  }

  async createTab(label: string, cwd: string, workspaceId?: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"];
    if (workspaceId) argv.push("--workspace", workspaceId);
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["root_pane"]);
  }

  async split(paneId: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["pane", "split", paneId, "--direction", "down", "--ratio", "0.3", "--cwd", cwd, "--no-focus"];
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["pane"]);
  }

  async run(paneId: string, commandLine: string): Promise<void> {
    await this.call(["pane", "run", paneId, commandLine]);
  }

  async status(paneId: string): Promise<AgentStatus> {
    let pane: Record<string, unknown>;
    try {
      pane = (await this.call(["pane", "get", paneId]))["pane"] as Record<string, unknown>;
    } catch (e) {
      if (e instanceof HerdrError && /not.?found/i.test(e.message)) return "gone";
      throw e;
    }
    if (!pane) return "gone";
    if (!pane["agent"]) return "shell";
    const s = String(pane["agent_status"] ?? "unknown");
    return (["idle", "working", "blocked", "done"].includes(s) ? s : "unknown") as AgentStatus;
  }

  /**
   * Delivers one message into a pane as a single argv element: nothing in it is ever
   * expanded by a shell. Agents get `agent prompt`; a plain shell pane gets text + Enter.
   * An agent herdr will not prompt (agent_not_ready, e.g. omo with a foreground SDK child)
   * gets the message typed as one line instead (see typeLine). Returns false when nothing was
   * delivered and the message must stay queued.
   */
  async deliver(paneId: string, text: string, kind: AgentStatus, entries: readonly Typed[]): Promise<boolean> {
    if (kind === "shell") {
      await this.type(paneId, text);
      return true;
    }
    try {
      await this.call(["agent", "prompt", paneId, text]);
      return true;
    } catch (e) {
      if (!(e instanceof HerdrError && /agent_not_ready/.test(e.message))) throw e;
      return this.typeLine(paneId, entries);
    }
  }

  /**
   * Types a message into an agent's input box as one line, `[from <sender>] ` first so it can never start
   * with a slash command or shell escape (the whole line, sender included, is flattened). Only an input box
   * seen empty is typed into, so a human's half-written prompt is never merged and submitted; returns false
   * (keep it queued) otherwise. Known limit: a keystroke landing between that read and send-text still merges.
   * Once the text is in, a failed Enter counts as delivered: retrying would type it a second time.
   */
  async typeLine(paneId: string, entries: readonly Typed[]): Promise<boolean> {
    if (!(await this.inputEmpty(paneId))) return false;
    await this.call(["pane", "send-text", paneId, typedLine(entries)]);
    try {
      await this.call(["pane", "send-keys", paneId, "enter"]);
    } catch (e) {
      if (!(e instanceof HerdrError)) throw e;
      process.stderr.write(`dori: text typed into ${paneId} but Enter failed (${e.message}); not retrying\n`);
    }
    return true;
  }

  /**
   * Best effort: true only when the bottom of the pane shows an input box holding nothing but its prompt
   * glyph. A draft is false quietly; no recognisable box or a failed read is false with a stderr note,
   * so a screen the parser does not know shows up instead of queueing in silence.
   */
  async inputEmpty(paneId: string): Promise<boolean> {
    let screen: string;
    try {
      screen = await this.read(paneId, 40);
    } catch (e) {
      if (!(e instanceof HerdrError)) throw e;
      this.noteOnce(paneId, `could not read ${paneId} to check its input box (${e.message}); queued`);
      return false;
    }
    const box = inputBox(screen);
    this.noteOnce(paneId, box === "none" ? `input box of ${paneId} not recognised; queued` : undefined);
    return box === "empty";
  }

  private notes = new Map<string, string>();
  /** Writes a note to stderr once per pane until it changes, so a duty loop does not repeat it every tick. */
  private noteOnce(paneId: string, note: string | undefined): void {
    if (note === undefined) this.notes.delete(paneId);
    else if (this.notes.get(paneId) !== note) {
      this.notes.set(paneId, note);
      process.stderr.write(`dori: ${note}\n`);
    }
  }

  /** Types text + Enter. omo takes typed input mid-turn as a follow-up, so this does not interrupt it. */
  async type(paneId: string, text: string): Promise<void> {
    await this.call(["pane", "send-text", paneId, text]);
    await this.call(["pane", "send-keys", paneId, "enter"]);
  }

  async read(paneId: string, lines = 80): Promise<string> {
    const full = this.session ? ["--session", this.session] : [];
    const res = await this.exec("herdr", [...full, "pane", "read", paneId, "--lines", String(lines), "--source", "recent"]);
    if (res.code !== 0) throw new HerdrError(["pane", "read", paneId], res);
    return res.stdout;
  }

  async close(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }
}

function toPaneRef(v: unknown): PaneRef {
  const o = (v ?? {}) as Record<string, unknown>;
  const paneId = String(o["pane_id"] ?? "");
  if (!paneId) throw new Error("herdr did not return a pane id");
  return { paneId, tabId: String(o["tab_id"] ?? ""), workspaceId: String(o["workspace_id"] ?? "") };
}

const BOTTOM_RULE = /^\s*─{10,}\s*$/;
/** omo labels the top rule while it works: `── • Working (4s • esc to interrupt) ────`. */
const TOP_RULE = /^\s*─{2,}.*─{3,}\s*$/;

/**
 * Reads the input box: the last pure horizontal rule and the rule above it. `empty` when the lines between
 * hold only prompt glyphs and spaces, `draft` when anything is typed there, `none` when there is no such box.
 */
export function inputBox(screen: string): "empty" | "draft" | "none" {
  const lines = screen.split("\n");
  const bottom = lines.findLastIndex((l) => BOTTOM_RULE.test(l));
  if (bottom < 1) return "none";
  const top = lines.slice(0, bottom).findLastIndex((l) => TOP_RULE.test(l));
  if (top < 0 || bottom - top < 2) return "none";
  const inside = lines.slice(top + 1, bottom);
  if (!inside.some((l) => l.includes("❯"))) return "none";
  return inside.every((l) => /^[\s❯]*$/.test(l)) ? "empty" : "draft";
}

/**
 * Flattens a message to one line so a typed Enter submits all of it at once.
 * Every other control character, C0, DEL and C1 (\r, ESC, Ctrl-U, Ctrl-C, CSI, ...), becomes a space: typed into
 * a PTY it would act as a key, submitting early, interrupting the agent or erasing the `[from ...]` prefix.
 * Known trade-off: code blocks, indentation and batch structure collapse into ` / `-joined text.
 */
export const oneLine = (s: string): string =>
  s.split(/\s*\n\s*/).filter(Boolean).join(" / ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export type Typed = { readonly from: string; readonly text: string };

/** Marks where each batched message starts; stripped from message text so a body cannot fake an entry. */
const ENTRY = "␞";

/**
 * The one line typed for queued messages. Each starts `[from <sender>] `; a batch is headed `[from dori]` and
 * every entry is opened with ␞, which no message text or sender can contain.
 */
export function typedLine(entries: readonly Typed[]): string {
  const clean = (s: string) => oneLine(s).replaceAll(ENTRY, " ");
  const one = (m: Typed) => `[from ${clean(m.from)}] ${clean(m.text)}`;
  if (entries.length === 1) return one(entries[0]!);
  return [`[from dori] ${entries.length} messages arrived while you were busy:`, ...entries.map((m, i) => `${ENTRY} (${i + 1}) ${one(m)}`)].join(" ");
}

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
