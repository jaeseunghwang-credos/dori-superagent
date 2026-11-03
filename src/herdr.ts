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

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
const PASTE_SETTLE_MS = 400;

/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
const ENTER_ATTEMPTS = 3;

const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯`
 * line, a bare rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the
 * input, an unknown layout) is false, so the caller keeps queueing. Stopgap for #62: herdr reports an omo
 * whose live monitors or background cells are running as `working` even between turns.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1]!) || !INPUT_RULE.test(lines[input + 1]!)) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

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
   */
  async deliver(paneId: string, text: string, kind: AgentStatus): Promise<void> {
    if (kind === "shell") {
      await this.call(["pane", "send-text", paneId, text]);
      await this.call(["pane", "send-keys", paneId, "enter"]);
      return;
    }
    try {
      await this.call(["agent", "prompt", paneId, text]);
    } catch (e) {
      // herdr only accepts `agent prompt` for agents it started itself (`herdr agent start`); an omo launched
      // with `pane run` is detected but refused. Fall back to typing the text and pressing Enter.
      // Match herdr's own output, never e.message: that carries argv, which includes the delivered text.
      if (!(e instanceof HerdrError) || !/agent_not_ready/.test(e.result.stderr || e.result.stdout)) throw e;
      // agent_not_ready also covers an agent that exited and left a shell in front: typing would run the text there.
      const st = await this.status(paneId);
      if (st === "shell" || st === "gone") throw e;
      // A multi-line paste swallows the Enter that follows it, so type the message as one line.
      await this.call(["pane", "send-text", paneId, text.trim().replace(/\s*\n\s*/g, " / ")]);
      await Bun.sleep(PASTE_SETTLE_MS);
      // The text is already in the pane: retry only the Enter, so a flaky key press never re-types the message.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.call(["pane", "send-keys", paneId, "enter"]);
          return;
        } catch (err) {
          if (attempt >= ENTER_ATTEMPTS) throw err;
        }
      }
    }
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

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
