import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintContext, fingerprintHook, hashText } from "../hooks/fingerprint.ts";
import { renderPending, renderRefresh, resolveEffectiveMatch } from "../hooks/render.ts";
import { PendingState } from "../pending/state.ts";
import { FINALIZE_TOOL, visibleTools } from "../pending/visibility.ts";

describe("hashText", () => {
  it("is deterministic and sensitive to input", () => {
    assert.equal(hashText("abc"), hashText("abc"));
    assert.notEqual(hashText("abc"), hashText("abd"));
    assert.equal(hashText("abc").length, 8);
  });
});

describe("fingerprints", () => {
  it("change when instructions or context change", () => {
    assert.equal(fingerprintHook(["a"]), fingerprintHook(["a"]));
    assert.notEqual(fingerprintHook(["a"]), fingerprintHook(["b"]));
    const files = [{ path: "c", content: "1" }];
    assert.equal(fingerprintContext(files), fingerprintContext(files));
    assert.notEqual(fingerprintContext(files), fingerprintContext([{ path: "c", content: "2" }]));
  });
});

describe("resolveEffectiveMatch", () => {
  it("combines instructions and caps context files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `c${i}.txt`), `content ${i}`);
    const match = await resolveEffectiveMatch(
      [
        { id: "a", when: { path: "f" }, instructions: ["One.", "Two."] },
        {
          id: "b",
          when: { path: "f" },
          context: [0, 1, 2, 3, 4].map((i) => ({ path: `c${i}.txt` })),
        },
      ],
      dir,
    );
    assert.equal(match.hasEffectiveOutput, true);
    assert.equal(match.contextFiles.length, 3);
    assert.ok(match.instructions.join("\n").includes("- One."));
  });
  it("treats blank output as non-effective", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeFileSync(join(dir, "empty.txt"), "   \n");
    const match = await resolveEffectiveMatch(
      [{ id: "a", when: { path: "f" }, context: [{ path: "empty.txt" }, { path: "missing.txt" }] }],
      dir,
    );
    assert.equal(match.hasEffectiveOutput, false);
  });
  it("truncates deterministically under the total cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(9000));
    const match = await resolveEffectiveMatch(
      [{ id: "a", when: { path: "f" }, instructions: ["Hi."], context: [{ path: "big.txt" }] }],
      dir,
    );
    assert.ok(match.contextFiles[0].content.length <= 4096 + 20);
    assert.equal(match.contextFiles[0].truncated, true);
  });
});

describe("renderPending", () => {
  it("states no file changed and names the exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    const match = await resolveEffectiveMatch(
      [{ id: "a", when: { path: "f" }, instructions: ["Use ESM."] }],
      dir,
    );
    const text = renderPending("write", "src/foo.ts", match);
    assert.ok(text.includes("Pending write for src/foo.ts. No file changed."));
    assert.ok(text.includes("Use ESM."));
    assert.ok(text.includes("Finalize to apply the pending write unchanged"));
    const refresh = renderRefresh("edit", "src/foo.ts", match);
    assert.ok(refresh.includes("remains unapplied"));
  });
});

describe("PendingState", () => {
  it("tracks a single pending slot and acknowledgement", () => {
    const state = new PendingState();
    assert.equal(state.pending, null);
    state.enter(
      { tool: "write", path: "f", absolutePath: "/p/f", args: {}, hookFingerprint: "h", contextFingerprint: "c", observedTurn: 3 },
      ["read", "write"],
    );
    assert.ok(state.pending);
    assert.ok(state.isAcknowledged("write", "/p/f", "h", "c"));
    assert.ok(!state.isAcknowledged("edit", "/p/f", "h", "c"));
    const taken = state.take();
    assert.equal(taken.pending.path, "f");
    assert.deepEqual(taken.restoreActive, ["read", "write"]);
    assert.equal(state.pending, null);
  });
  it("keeps the first active snapshot across re-entry", () => {
    const state = new PendingState();
    state.enter(
      { tool: "write", path: "f", absolutePath: "/p/f", args: {}, hookFingerprint: "h", contextFingerprint: "c", observedTurn: 1 },
      ["read"],
    );
    state.enter(
      { tool: "write", path: "f", absolutePath: "/p/f", args: {}, hookFingerprint: "h2", contextFingerprint: "c2", observedTurn: 2 },
      ["write", "finalize"],
    );
    assert.deepEqual(state.take().restoreActive, ["read"]);
  });
  it("clears acknowledgement only with clearAll", () => {
    const state = new PendingState();
    state.enter(
      { tool: "edit", path: "f", absolutePath: "/p/f", args: {}, hookFingerprint: "h", contextFingerprint: "c", observedTurn: 1 },
      [],
    );
    state.clear();
    assert.ok(state.isAcknowledged("edit", "/p/f", "h", "c"));
    state.clearAll();
    assert.ok(!state.isAcknowledged("edit", "/p/f", "h", "c"));
  });
});

describe("visibleTools", () => {
  it("returns the base surface when idle", () => {
    assert.deepEqual(visibleTools(["read", "write"], null), ["read", "write"]);
  });
  it("collapses to the intercepted tool plus finalize", () => {
    assert.deepEqual(visibleTools(["read", "edit", "write"], "write"), ["write", FINALIZE_TOOL]);
    assert.deepEqual(visibleTools(["read", "edit", "write"], "edit"), ["edit", FINALIZE_TOOL]);
  });
});
