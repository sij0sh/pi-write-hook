import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HookRule } from "../hooks/config.ts";
import {
  globToRegExp,
  matchHooks,
  matchRule,
  resolveTarget,
  stripAtPrefix,
} from "../hooks/match.ts";

function rule(overrides: Partial<HookRule> = {}): HookRule {
  return { id: "r", when: {}, ...overrides };
}

describe("stripAtPrefix", () => {
  it("strips a leading @", () => {
    assert.equal(stripAtPrefix("@src/foo.ts"), "src/foo.ts");
  });
  it("leaves other paths alone", () => {
    assert.equal(stripAtPrefix("src/foo.ts"), "src/foo.ts");
  });
});

describe("resolveTarget", () => {
  it("resolves relative paths against cwd", () => {
    const target = resolveTarget("src/foo.ts", "/proj");
    assert.equal(target.absolute, "/proj/src/foo.ts");
    assert.equal(target.relative, "src/foo.ts");
  });
  it("strips @ before resolving", () => {
    const target = resolveTarget("@src/foo.ts", "/proj");
    assert.equal(target.absolute, "/proj/src/foo.ts");
  });
});

describe("globToRegExp", () => {
  it("matches * within a segment", () => {
    assert.ok(globToRegExp("src/*.ts").test("src/foo.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/nested/foo.ts"));
  });
  it("matches ** across segments", () => {
    assert.ok(globToRegExp("src/**/*.ts").test("src/nested/foo.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/foo.ts"));
  });
  it("matches ? as one character", () => {
    assert.ok(globToRegExp("src/fo?.ts").test("src/foo.ts"));
    assert.ok(!globToRegExp("src/fo?.ts").test("src/fooo.ts"));
  });
});

describe("matchRule", () => {
  it("matches exact path", () => {
    assert.ok(matchRule(rule({ when: { path: "src/foo.ts" } }), "write", "src/foo.ts"));
    assert.ok(!matchRule(rule({ when: { path: "src/foo.ts" } }), "write", "src/bar.ts"));
  });
  it("filters by tool", () => {
    assert.ok(!matchRule(rule({ when: { tool: "edit", path: "src/foo.ts" } }), "write", "src/foo.ts"));
    assert.ok(matchRule(rule({ when: { tool: "edit", path: "src/foo.ts" } }), "edit", "src/foo.ts"));
  });
  it("matches globs", () => {
    assert.ok(matchRule(rule({ when: { glob: "src/**/*.ts" } }), "write", "src/a/b.ts"));
    assert.ok(!matchRule(rule({ when: { glob: "src/**/*.ts" } }), "write", "lib/a.ts"));
  });
  it("matches extensions with or without a dot", () => {
    assert.ok(matchRule(rule({ when: { ext: ".ts" } }), "write", "src/foo.ts"));
    assert.ok(matchRule(rule({ when: { ext: "ts" } }), "write", "src/foo.ts"));
    assert.ok(!matchRule(rule({ when: { ext: "ts" } }), "write", "src/foo.js"));
  });
  it("matches basenames", () => {
    assert.ok(matchRule(rule({ when: { basename: "package.json" } }), "write", "sub/package.json"));
    assert.ok(!matchRule(rule({ when: { basename: "package.json" } }), "write", "sub/other.json"));
  });
  it("requires every specified selector to match", () => {
    const both = rule({ when: { glob: "src/**/*.ts", basename: "foo.ts" } });
    assert.ok(matchRule(both, "write", "src/foo.ts"));
    assert.ok(!matchRule(both, "write", "src/bar.ts"));
  });
  it("skips a filetype rule for a blacklisted basename", () => {
    const md = rule({ when: { ext: "md" }, exclude: { basename: "README.md" } });
    assert.ok(matchRule(md, "write", "docs/guide.md"));
    assert.ok(!matchRule(md, "write", "README.md"));
    assert.ok(!matchRule(md, "write", "docs/README.md"));
  });
  it("requires every specified exclude selector to match before skipping", () => {
    const md = rule({ when: { ext: "md" }, exclude: { basename: "README.md", glob: "docs/**" } });
    assert.ok(matchRule(md, "write", "README.md"));
    assert.ok(matchRule(md, "write", "docs/guide.md"));
    assert.ok(!matchRule(md, "write", "docs/README.md"));
  });
  it("supports tool and glob excludes, and ignores an empty exclude", () => {
    const editOnly = rule({ when: { ext: "ts" }, exclude: { tool: "edit" } });
    assert.ok(!matchRule(editOnly, "edit", "src/foo.ts"));
    assert.ok(matchRule(editOnly, "write", "src/foo.ts"));
    const noDrafts = rule({ when: { glob: "src/**/*.ts" }, exclude: { glob: "src/drafts/**" } });
    assert.ok(matchRule(noDrafts, "write", "src/foo.ts"));
    assert.ok(!matchRule(noDrafts, "write", "src/drafts/foo.ts"));
    const empty = rule({ when: { ext: "ts" }, exclude: {} });
    assert.ok(matchRule(empty, "write", "src/foo.ts"));
  });
});

describe("matchHooks", () => {
  it("returns only matching rules", () => {
    const rules = [
      rule({ id: "a", when: { path: "src/foo.ts" } }),
      rule({ id: "b", when: { path: "src/bar.ts" } }),
    ];
    assert.deepEqual(matchHooks(rules, "write", "src/foo.ts").map((r) => r.id), ["a"]);
  });
});
