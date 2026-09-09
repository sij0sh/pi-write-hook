import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCheckNames,
  extractStagedContent,
  runPreChecks,
  type CheckInput,
} from "../hooks/checks.ts";

function inputFor(cwd: string, extra?: Partial<CheckInput>): CheckInput {
  return {
    phase: "pre",
    tool: "write",
    cwd,
    relativePath: "src/foo.ts",
    absolutePath: join(cwd, "src/foo.ts"),
    stagedContent: "export const x = 1;\n",
    diskContent: null,
    ...extra,
  };
}

function writeCheck(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, ".pi", "write-hook", "checks"), { recursive: true });
  writeFileSync(join(dir, ".pi", "write-hook", "checks", `${name}.mjs`), body);
}

const PASS = `console.log(JSON.stringify({ verdict: "pass", message: "" }));`;
const WARN = `console.log(JSON.stringify({ verdict: "warn", message: "too big" }));`;
const BLOCK = `console.log(JSON.stringify({ verdict: "block", message: "no unicode" }));`;

function fromArg(expr: string): string {
  return `const input = JSON.parse(process.argv[2] ?? "{}");\nconsole.log(JSON.stringify(${expr}));`;
}

describe("collectCheckNames", () => {
  it("dedupes in match order and caps at three", async () => {
    const { collectCheckNames } = await import("../hooks/checks.ts");
    assert.deepEqual(
      collectCheckNames([
        { id: "a", when: { path: "x" }, checks: ["one", "two"] },
        { id: "b", when: { path: "x" }, checks: ["two", "three", "four"] },
      ]),
      ["one", "two", "three"],
    );
  });
});

describe("extractStagedContent", () => {
  it("reads write content and edit replacements", () => {
    assert.equal(extractStagedContent("write", { path: "f", content: "hello" }), "hello");
    assert.equal(extractStagedContent("write", { path: "f" }), undefined);
    assert.equal(
      extractStagedContent("edit", { path: "f", edits: [{ oldText: "a", newText: "b" }] }),
      "b",
    );
    assert.equal(
      extractStagedContent("edit", {
        path: "f",
        edits: [{ insert_after: { anchor: "1:x", content: "inserted" } }],
      }),
      "inserted",
    );
    assert.equal(extractStagedContent("edit", { path: "f", edits: [] }), undefined);
  });
});

describe("runPreChecks", () => {
  it("returns pass for unknown names without running anything", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    const summary = await runPreChecks(["missing"], inputFor(cwd));
    assert.deepEqual(summary, { messages: [], triggered: false });
  });
  it("collects warn messages in order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeCheck(cwd, "first", WARN);
    writeCheck(cwd, "second", fromArg(`({ verdict: "warn", message: "second hit" })`));
    const summary = await runPreChecks(["first", "second"], inputFor(cwd));
    assert.equal(summary.triggered, true);
    assert.equal(summary.blocked, undefined);
    assert.deepEqual(summary.messages, ["[check:first] too big", "[check:second] second hit"]);
  });
  it("stops at the first block", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeCheck(cwd, "wall", WARN);
    writeCheck(cwd, "gate", BLOCK);
    writeCheck(cwd, "late", WARN);
    const summary = await runPreChecks(["wall", "gate", "late"], inputFor(cwd));
    assert.equal(summary.triggered, true);
    assert.equal(summary.blocked, "[check:gate] no unicode");
    assert.deepEqual(summary.messages, ["[check:wall] too big"]);
  });
  it("treats bad JSON and slow scripts as pass", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeCheck(cwd, "loud", `console.log("not json");`);
    writeCheck(cwd, "slow", `setTimeout(() => console.log(JSON.stringify({ verdict: "block", message: "late" })), 20000);`);
    const summary = await runPreChecks(["loud", "slow"], inputFor(cwd));
    assert.deepEqual(summary, { messages: [], triggered: false });
  });
  it("sees staged content in argv", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeCheck(cwd, "echo", fromArg(`({ verdict: "warn", message: String(input.stagedContent ?? "empty") })`));
    const summary = await runPreChecks(["echo"], inputFor(cwd, { stagedContent: "ping" }));
    assert.deepEqual(summary.messages, ["[check:echo] ping"]);
    assert.ok(PASS.length > 0);
  });
});
