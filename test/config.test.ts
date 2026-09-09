import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_ENV_OVERRIDE,
  composeConfigs,
  hasEffectiveHooks,
  loadConfig,
  parseConfig,
} from "../hooks/config.ts";

describe("parseConfig", () => {
  it("keeps valid rules and drops selector-less ones", () => {
    const parsed = parseConfig({
      rules: [
        { id: "ok", when: { path: "src/foo.ts" }, instructions: ["Use ESM."] },
        { id: "lost", when: {}, instructions: ["No target."] },
        { id: "", when: { path: "x" } },
      ],
    });
    assert.deepEqual(parsed.config.rules.map((r) => r.id), ["ok"]);
    assert.equal(parsed.warnings.length, 2);
  });
  it("trims blank instructions and warns on fetch directives", () => {
    const parsed = parseConfig({
      rules: [{ id: "f", when: { ext: "ts" }, instructions: ["  ", "Read the config file first."] }],
    });
    assert.deepEqual(parsed.config.rules[0].instructions, ["Read the config file first."]);
    assert.ok(parsed.warnings.some((w) => w.includes('"f"')));
  });
  it("rejects non-object input", () => {
    assert.deepEqual(parseConfig(undefined).config.rules, []);
  });
  it("keeps a usable exclude blacklist and drops an empty one", () => {
    const parsed = parseConfig({
      rules: [
        { id: "md", when: { ext: "md" }, exclude: { basename: "README.md" }, instructions: ["MD."] },
        { id: "plain", when: { ext: "md" }, exclude: {}, instructions: ["Plain."] },
        { id: "junk", when: { ext: "md" }, exclude: { path: "   " }, instructions: ["Junk."] },
      ],
    });
    assert.deepEqual(parsed.config.rules.map((r) => r.id), ["md", "plain", "junk"]);
    assert.deepEqual(parsed.config.rules[0].exclude, { basename: "README.md" });
    assert.equal(parsed.config.rules[1].exclude, undefined);
    assert.equal(parsed.config.rules[2].exclude, undefined);
  });
});

describe("composeConfigs", () => {
  it("lets project rules replace global rules by id", () => {
    const composed = composeConfigs(
      {
        rules: [
          { id: "a", when: { path: "x" }, instructions: ["global"] },
          { id: "b", when: { path: "y" }, instructions: ["global-b"] },
        ],
      },
      { rules: [{ id: "a", when: { path: "x" }, instructions: ["project"] }] },
    );
    assert.deepEqual(composed.rules.map((r) => r.id), ["a", "b"]);
    assert.deepEqual(composed.rules[0].instructions, ["project"]);
  });
});

describe("shipped roast hooks", () => {
  it("parses to one effective edit-only rule", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(new URL("../roast-hooks/edit-write.json", import.meta.url), "utf-8"),
    );
    const parsed = parseConfig(raw);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.config.rules.length, 1);
    assert.equal(hasEffectiveHooks(parsed.config), true);
  });
  it("parses the polyglot config to three effective edit-only rules", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(new URL("../roast-hooks/edit-write-polyglot.json", import.meta.url), "utf-8"),
    );
    const parsed = parseConfig(raw);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.config.rules.length, 3);
    assert.equal(hasEffectiveHooks(parsed.config), true);
    for (const rule of parsed.config.rules) {
      assert.equal(rule.when.tool, "edit");
      assert.ok((rule.instructions?.length ?? 0) === 3);
    }
  });
});

describe("hasEffectiveHooks", () => {
  it("is false for empty or output-less configs", () => {
    assert.equal(hasEffectiveHooks({ rules: [] }), false);
    assert.equal(hasEffectiveHooks({ rules: [{ id: "x", when: { path: "f" } }] }), false);
  });
  it("is true for instructions or context includes", () => {
    assert.equal(
      hasEffectiveHooks({ rules: [{ id: "x", when: { path: "f" }, instructions: ["Do this."] }] }),
      true,
    );
    assert.equal(
      hasEffectiveHooks({ rules: [{ id: "x", when: { path: "f" }, context: [{ path: "c" }] }] }),
      true,
    );
  });
});

describe("loadConfig", () => {
  it("honors the test-only env override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    const file = join(dir, "hooks.json");
    writeFileSync(file, JSON.stringify({ rules: [{ id: "e", when: { path: "a" }, instructions: ["Hi."] }] }));
    process.env[CONFIG_ENV_OVERRIDE] = file;
    try {
      const loaded = await loadConfig(dir);
      assert.deepEqual(loaded.config.rules.map((r) => r.id), ["e"]);
      assert.ok(loaded.fingerprint.length > 0);
    } finally {
      delete process.env[CONFIG_ENV_OVERRIDE];
    }
  });
  it("loads the project layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    mkdirSync(join(dir, ".pi", "hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "hooks", "edit-write.json"),
      JSON.stringify({ rules: [{ id: "p", when: { ext: "ts" }, instructions: ["Typed."] }] }),
    );
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config.rules.map((r) => r.id), ["p"]);
  });
  it("warns when the env override is unreadable", async () => {
    process.env[CONFIG_ENV_OVERRIDE] = join(mkdtempSync(join(tmpdir(), "write-hook-")), "missing.json");
    try {
      const loaded = await loadConfig(tmpdir());
      assert.deepEqual(loaded.config.rules, []);
      assert.ok(loaded.warnings.some((w) => w.includes("unreadable")));
    } finally {
      delete process.env[CONFIG_ENV_OVERRIDE];
    }
  });
  it("returns empty config when no files exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-hook-"));
    const loaded = await loadConfig(join(dir, "missing"));
    assert.deepEqual(loaded.config.rules, []);
  });
});
