import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type HookRule } from "../hooks/config.ts";
import { PendingState } from "../pending/state.ts";
import { executeFinalize } from "../tools/finalize.ts";
import {
  executeMutation,
  type MutationRuntime,
  type NativeCall,
  type TextResult,
} from "../tools/mutation.ts";

interface Fake {
  state: PendingState;
  rt: MutationRuntime;
  active: string[];
  nativeCalls: Array<{ tool: string; args: unknown }>;
  failNative: boolean;
  rules: HookRule[];
  cwd: string;
  setTurn(n: number): void;
  call(tool: "edit" | "write", args: unknown): Promise<TextResult>;
  finalize(): Promise<TextResult>;
}

function rulesOf(doc: unknown): HookRule[] {
  return parseConfig(doc).config.rules;
}

function makeFake(extra?: { rules?: HookRule[]; cwd?: string }): Fake {
  const cwd = extra?.cwd ?? mkdtempSync(join(tmpdir(), "write-hook-"));
  const state = new PendingState();
  const fake: Fake = {
    state,
    active: ["read", "edit", "write", "bash"],
    nativeCalls: [],
    failNative: false,
    rules: extra?.rules ?? [],
    cwd,
    setTurn(n: number) {
      state.setTurn(n);
    },
    call(tool: "edit" | "write", args: unknown) {
      const call: NativeCall = { toolCallId: "t", signal: undefined, onUpdate: undefined, ctx: { cwd } };
      return executeMutation(tool, args, call, fake.rt);
    },
    finalize() {
      const call: NativeCall = { toolCallId: "f", signal: undefined, onUpdate: undefined, ctx: { cwd } };
      return executeFinalize(call, fake.rt);
    },
  } as unknown as Fake;
  fake.rt = {
    state,
    getActiveTools: () => [...fake.active],
    setActiveTools: (names: string[]) => {
      fake.active = [...names];
    },
    loadConfig: async () => ({ config: { rules: fake.rules }, warnings: [], fingerprint: "test" }),
    nativeExecute: async (tool: "edit" | "write", args: unknown) => {
      if (fake.failNative) throw new Error("native boom");
      fake.nativeCalls.push({ tool, args });
      return { content: [{ type: "text" as const, text: "native-ok" }], details: {} };
    },
  };
  return fake;
}

const WRITE_ARGS = { path: "src/foo.ts", content: "export const x = 1;\n" };
const EDIT_ARGS = { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] };

function hookedRules(): HookRule[] {
  return rulesOf({
    rules: [{ id: "esm", when: { path: "src/foo.ts" }, instructions: ["Use ESM imports."] }],
  });
}

describe("native parity", () => {
  it("passes through with no rules and leaves the surface alone", async () => {
    const fake = makeFake();
    const result = await fake.call("write", WRITE_ARGS);
    assert.equal(result.content[0].text, "native-ok");
    assert.deepEqual(fake.active, ["read", "edit", "write", "bash"]);
    assert.equal(fake.state.pending, null);
  });
  it("passes through for unrelated targets", async () => {
    const fake = makeFake({ rules: hookedRules() });
    const result = await fake.call("write", { path: "src/other.ts", content: "x" });
    assert.equal(result.content[0].text, "native-ok");
    assert.equal(fake.state.pending, null);
  });
  it("treats blank-output matches as nonmatching", async () => {
    const fake = makeFake({
      rules: [{ id: "blank", when: { path: "src/foo.ts" }, instructions: [] }],
    });
    const result = await fake.call("write", WRITE_ARGS);
    assert.equal(result.content[0].text, "native-ok");
    assert.equal(fake.state.pending, null);
  });
});

describe("pending entry", () => {
  it("stages a matching write without mutating", async () => {
    const fake = makeFake({ rules: hookedRules() });
    const result = await fake.call("write", WRITE_ARGS);
    assert.ok(result.content[0].text.includes("Pending write for src/foo.ts. No file changed."));
    assert.ok(result.content[0].text.includes("Use ESM imports."));
    assert.equal(fake.nativeCalls.length, 0);
    assert.deepEqual(fake.active, ["write", "finalize"]);
    assert.ok(fake.state.pending);
  });
  it("stages a matching edit", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("edit", EDIT_ARGS);
    assert.deepEqual(fake.active, ["edit", "finalize"]);
    assert.equal(fake.state.pending?.tool, "edit");
  });
});

describe("finalize", () => {
  it("commits original args exactly once on a later turn", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    const result = await fake.finalize();
    assert.equal(result.content[0].text, "native-ok");
    assert.equal(fake.nativeCalls.length, 1);
    assert.deepEqual(fake.nativeCalls[0].args, WRITE_ARGS);
    assert.deepEqual(fake.active, ["read", "edit", "write", "bash"]);
    assert.equal(fake.state.metrics.finalizedUnchanged, 1);
  });
  it("blocks same-turn finalize", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    const result = await fake.finalize();
    assert.ok(result.content[0].text.includes("later turn"));
    assert.equal(fake.nativeCalls.length, 0);
    assert.ok(fake.state.pending);
    assert.equal(fake.state.metrics.sameTurnDecisionAttempts, 1);
  });
  it("reports no pending mutation when idle", async () => {
    const fake = makeFake({ rules: hookedRules() });
    const result = await fake.finalize();
    assert.ok(result.content[0].text.includes("No mutation is pending."));
  });
  it("clears pending and restores the surface when native execution fails", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    fake.failNative = true;
    await assert.rejects(() => fake.finalize(), /native boom/);
    assert.equal(fake.state.pending, null);
    assert.deepEqual(fake.active, ["read", "edit", "write", "bash"]);
  });
});

describe("revision", () => {
  it("executes revised same-target args with no second hook round", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    const revised = { path: "src/foo.ts", content: "export const x = 2;\n" };
    const result = await fake.call("write", revised);
    assert.equal(result.content[0].text, "native-ok");
    assert.equal(fake.nativeCalls.length, 1);
    assert.deepEqual(fake.nativeCalls[0].args, revised);
    assert.deepEqual(fake.active, ["read", "edit", "write", "bash"]);
    assert.equal(fake.state.metrics.revisedBeforeCommit, 1);
  });
  it("blocks same-turn revision", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    const result = await fake.call("write", { path: "src/foo.ts", content: "v2" });
    assert.ok(result.content[0].text.includes("later turn"));
    assert.equal(fake.nativeCalls.length, 0);
  });
  it("blocks different-target mutation while pending", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    const result = await fake.call("write", { path: "src/bar.ts", content: "x" });
    assert.ok(result.content[0].text.includes("A write for src/foo.ts is pending."));
    assert.equal(fake.nativeCalls.length, 0);
    assert.equal(fake.state.pending?.path, "src/foo.ts");
    assert.equal(fake.state.metrics.pendingTargetMismatches, 1);
  });
  it("blocks a different tool while pending", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    const result = await fake.call("edit", EDIT_ARGS);
    assert.ok(result.content[0].text.includes("is pending"));
    assert.equal(fake.nativeCalls.length, 0);
  });
});

describe("acknowledgement", () => {
  it("runs later same-target mutations natively without restaging", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    await fake.finalize();
    fake.setTurn(2);
    const result = await fake.call("write", { path: "src/foo.ts", content: "v3" });
    assert.equal(result.content[0].text, "native-ok");
    assert.equal(fake.nativeCalls.length, 2);
    assert.equal(fake.state.metrics.hookedFirstAttempts, 1);
  });
});

describe("staleness", () => {
  it("re-shows hooks instead of committing when context changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    writeFileSync(join(cwd, "tsconfig.json"), '{"strict":true}');
    const fake = makeFake({
      cwd,
      rules: rulesOf({
        rules: [
          {
            id: "cfg",
            when: { path: "src/foo.ts" },
            instructions: ["Follow the compiler config."],
            context: [{ path: "tsconfig.json" }],
          },
        ],
      }),
    });
    await fake.call("write", WRITE_ARGS);
    writeFileSync(join(cwd, "tsconfig.json"), '{"strict":false}');
    fake.setTurn(1);
    const refresh = await fake.finalize();
    assert.ok(refresh.content[0].text.includes("remains unapplied"));
    assert.equal(fake.nativeCalls.length, 0);
    assert.equal(fake.state.metrics.stalePendingInvalidations, 1);
    fake.setTurn(2);
    await fake.finalize();
    assert.equal(fake.nativeCalls.length, 1);
  });
});

describe("economy metrics", () => {
  it("supports the finalizedUnchanged / hookedFirstAttempts ratio", async () => {
    const fake = makeFake({ rules: hookedRules() });
    await fake.call("write", WRITE_ARGS);
    fake.setTurn(1);
    await fake.finalize();
    const { hookedFirstAttempts, finalizedUnchanged } = fake.state.metrics;
    assert.equal(hookedFirstAttempts, 1);
    assert.equal(finalizedUnchanged / hookedFirstAttempts, 1);
  });
});

describe("extension wiring", () => {
  async function setup(configDoc: unknown | undefined) {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "write-hook-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "write-hook-"));
    if (configDoc !== undefined) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(cwd, ".pi", "write-hook"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "write-hook", "edit-write.json"), JSON.stringify(configDoc));
    }
    const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
    const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<TextResult> }>();
    let active = ["read", "edit", "write", "bash"];
    const pi = {
      on: (event: string, handler: (event: never, ctx: never) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool: (definition: { name: string; execute: (...args: any[]) => Promise<TextResult> }) => {
        tools.set(definition.name, definition);
      },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = [...names];
      },
    };
    const { default: writeHook } = await import("../index.ts");
    writeHook(pi as never);
    const emit = async (event: string, payload: unknown, ctx: unknown) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx as never);
    };
    return { cwd, tools, emit, getActive: () => [...active] };
  }

  it("registers nothing without effective hooks", async () => {
    const { tools, emit, cwd } = await setup(undefined);
    await emit("session_start", { reason: "startup" }, { cwd });
    assert.equal(tools.size, 0);
  });

  it("stages and finalizes a real hooked write end to end", async () => {
    const { cwd, tools, emit, getActive } = await setup({
      rules: [{ id: "esm", when: { path: "src/foo.ts" }, instructions: ["Use ESM imports."] }],
    });
    await emit("session_start", { reason: "startup" }, { cwd });
    assert.ok(tools.has("edit") && tools.has("write") && tools.has("finalize"));
    assert.ok(!getActive().includes("finalize"));

    const ctx = { cwd };
    await emit("turn_start", { turnIndex: 0 }, ctx);
    const write = tools.get("write") as { execute: (...args: any[]) => Promise<TextResult> };
    const staged = await write.execute("c1", { path: "src/foo.ts", content: "export const x = 1;\n" }, undefined, undefined, ctx);
    assert.ok(staged.content[0].text.includes("Pending write"));
    assert.ok(!existsSync(join(cwd, "src", "foo.ts")));
    assert.deepEqual(getActive(), ["write", "finalize"]);

    await emit("turn_start", { turnIndex: 1 }, ctx);
    const finalize = tools.get("finalize") as { execute: (...args: any[]) => Promise<TextResult> };
    await finalize.execute("c2", {}, undefined, undefined, ctx);
    assert.equal(readFileSync(join(cwd, "src", "foo.ts"), "utf-8"), "export const x = 1;\n");
    assert.deepEqual(getActive(), ["read", "edit", "write", "bash"]);
  });

  it("passes nonmatching writes through to the real file", async () => {
    const { cwd, tools, emit } = await setup({
      rules: [{ id: "esm", when: { path: "src/foo.ts" }, instructions: ["Use ESM imports."] }],
    });
    await emit("session_start", { reason: "startup" }, { cwd });
    const ctx = { cwd };
    await emit("turn_start", { turnIndex: 0 }, ctx);
    const write = tools.get("write") as { execute: (...args: any[]) => Promise<TextResult> };
    await write.execute("c1", { path: "src/plain.ts", content: "plain\n" }, undefined, undefined, ctx);
    assert.equal(readFileSync(join(cwd, "src", "plain.ts"), "utf-8"), "plain\n");
  });
});
