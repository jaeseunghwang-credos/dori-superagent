import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, dutyTick, flushInbox, mergeGate, ready, Refusal, report, review, send, startLane } from "../src/harness.ts";
import { inputBox } from "../src/herdr.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { workspace: "w1" })).rejects.toThrow(Refusal);
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("pane messaging", () => {
  test("a blocked lead is never typed into: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { workspace: "w1" });
    lead.received.length = 0;
    lead.status = "blocked";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("a lead herdr reports busy still gets the message now, typed as one line", async () => {
    const { w, d, lead } = setup();
    lead.status = "working";
    expect(await send(d, "lead", "[READY x] done\nevidence: pr", "x")).toBe("DELIVERED");
    expect(lead.received).toEqual(["[from x] [READY x] done / evidence: pr"]);
    expect(w.calls.at(-1)!.argv).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
    expect(d.store.queued("w1:p1")).toEqual([]);
  });

  test("agent_not_ready falls back to typing one line instead of queueing", async () => {
    const { d, lead } = setup();
    lead.notReady = true;
    expect(await send(d, "lead", "a\n\nb", "x")).toBe("DELIVERED");
    expect(lead.received).toEqual(["[from x] a / b"]);
  });

  test("typed text always starts with the sender, so a leading / or ! is never a command", async () => {
    const { d, lead } = setup();
    lead.status = "working";
    await send(d, "lead", "/quit", "telegram");
    await send(d, "lead", "!rm -rf ~", "a-lane");
    expect(lead.received).toEqual(["[from telegram] /quit", "[from a-lane] !rm -rf ~"]);
  });

  test("a half-written draft, or a screen with no input box, is never typed into: it queues", async () => {
    const { d, lead } = setup();
    lead.status = "working";
    lead.draft = "half a thou";
    expect(await send(d, "lead", "note", "x")).toBe("QUEUED");
    lead.draft = null;
    expect(await send(d, "lead", "note 2", "x")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.draft = "";
    expect(await flushInbox(d, "w1:p1")).toBe(true);
    expect(lead.received).toEqual(["[from dori] 2 messages arrived while you were busy: / (1) from x: / note / (2) from x: / note 2"]);
  });

  test("the input box is read from raw herdr captures of a real omo pane, busy and between steps", () => {
    for (const name of ["omo-input-busy.txt", "omo-input-between-steps.txt"]) {
      const screen = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
      expect(inputBox("earlier output\n" + screen)).toBe("empty");
      expect(inputBox(screen.replace("❯", "❯ half a thought"))).toBe("draft");
    }
    expect(inputBox("out\n❯\n~/workspace • status")).toBe("none");
    const rule = "─".repeat(40);
    expect(inputBox([rule, "❯ >", rule].join("\n"))).toBe("draft");
    expect(inputBox([rule, "│ a table cell │", rule].join("\n"))).toBe("none");
  });

  test("control characters in the text or sender are never typed as keys", async () => {
    const { d, lead } = setup();
    lead.status = "working";
    await send(d, "lead", "hi\r/quit", "x");
    await send(d, "lead", "a\x1bb\x15c\x03d", "y\r!z");
    expect(lead.received).toEqual(["[from x] hi /quit", "[from y !z] a b c d"]);
    expect(lead.received.join("")).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  test("a newline in the sender cannot split the typed line", async () => {
    const { d, lead } = setup();
    lead.status = "working";
    await send(d, "lead", "hi", "x\n/quit");
    expect(lead.received).toEqual(["[from x / /quit] hi"]);
  });

  test("a shell pane whose Enter fails still raises, as before", async () => {
    const { w, d } = setup();
    const sh = w.addPane("w1:p8", "shell");
    sh.enterFails = true;
    await expect(send(d, "w1:p8", "ls", "lead")).rejects.toThrow("key_failed");
  });

  test("a lead whose state herdr cannot classify is not typed into", async () => {
    const { d, lead } = setup();
    lead.status = "unknown";
    expect(await send(d, "lead", "hi", "x")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("a failed Enter after the text went in counts as delivered, so a retry never types it twice", async () => {
    const { d, lead } = setup();
    lead.status = "working";
    lead.enterFails = true;
    expect(await send(d, "lead", "once", "x")).toBe("DELIVERED");
    expect(await flushInbox(d, "w1:p1")).toBe(true);
    expect(lead.received).toEqual(["[from x] once"]);
  });

  test("an agent prompt error other than agent_not_ready is raised, not typed", async () => {
    const { d, lead } = setup();
    lead.promptError = "boom";
    await expect(send(d, "lead", "hi", "x")).rejects.toThrow("boom");
    expect(lead.received).toEqual([]);
  });

  test("an idle lane herdr cannot prompt gets the typed fallback too", async () => {
    const { w, d } = setup();
    const lane = w.addPane("w1:p9", "idle");
    lane.notReady = true;
    expect(await send(d, "w1:p9", "go", "lead")).toBe("DELIVERED");
    expect(lane.received).toEqual(["[from lead] go"]);
  });

  test("a busy lane is not typed into; it still queues", async () => {
    const { w, d } = setup();
    const lane = w.addPane("w1:p9", "working");
    expect(await send(d, "w1:p9", "hi", "lead")).toBe("QUEUED");
    expect(lane.received).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("nudges an idle lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const at = async (min: number) => { w.clock = lane.createdAt + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("idle for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief, { workspace: "w1" });
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a working lane counts as activity; a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    expect(w.touches).toBeGreaterThan(0);
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome))
      .toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a reviewer without a VERDICT line writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "looks fine I guess" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });
});
