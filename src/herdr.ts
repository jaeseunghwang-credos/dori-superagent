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
   * gets the message typed as one line instead.
   */
  async deliver(paneId: string, text: string, kind: AgentStatus): Promise<void> {
    if (kind === "shell") return this.type(paneId, text);
    try {
      await this.call(["agent", "prompt", paneId, text]);
    } catch (e) {
      if (!(e instanceof HerdrError && /agent_not_ready/.test(e.message))) throw e;
      await this.type(paneId, oneLine(text));
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

/** Flattens a message to one line so a typed Enter submits all of it at once. */
export const oneLine = (s: string): string =>
  s.split(/\s*\n\s*/).filter(Boolean).join(" / ");

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
