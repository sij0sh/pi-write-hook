# write-hook

> Rules that stay out of the context window until they are needed.

`write-hook` is a Pi extension that defers `edit` and `write` calls matching your rules until the agent confirms or corrects them.

## Why this exists

Important instructions in `AGENTS.md` degrade as sessions grow: they compete with everything else in context. A default hook on every edit or write has the opposite fault: it fires whether it is relevant or not, so its output becomes noise or triggers rewrites of files that were already fine.

`write-hook` fires only when a rule matches the target. The mutation stages without touching the filesystem and the tool surface collapses to the intercepted tool plus `finalize`. The agent either accepts the staged content with `finalize()` or issues a revised `edit`/`write` for the same target, which applies directly with no second hook round. This means you get custom context exact where you want it, when you want it, with little impact to the remaining session.

## Footprint

- Vetted with `roastmyharness` and A/B-tested against over a dozen competing designs for as minimum cost as possible.
- Invisible until triggered: with no matching rule, native `edit`/`write` run untouched, and with no effective hooks configured the extension registers nothing.
- Ships with no rules by default, so it has no footprint whatsoever until you ask Pi to create rules.
- If the staged content already follows the rule, the agent confirms with zero-arg `finalize()` and the context cost stays near zero. You pay only when the rule would otherwise have been missed.

## Prerequisites

- Node `>=22.18.0` (per `engines` in `package.json`).
- Pi `>=0.85.1 <0.86.0` with `typebox ^1.3.7` (per `peerDependencies`).

## Install

Requires Node.js `>=22.18.0` and Pi `>=0.85.1 <0.86.0`.

From local path:

```bash
pi install /home/joshsimon/Projects/pi-extensions/write-hook
```

The extension ships as TypeScript source. Pi loads it through its own loader. No runtime dependencies.

Create at least one rule (see Configure). With zero effective rules the extension stays dormant by design.

Uninstall:

```bash
pi remove /home/joshsimon/Projects/pi-extensions/write-hook
```

## First success

1. Save the example config below as `<project>/.pi/hooks/edit-write.json`.
2. Ask Pi to write a matching file, for example `docs/notes.md`.
3. Watch the first mutation stage instead of writing. On a later turn run `finalize()` to apply it unchanged, or send a revised `edit`/`write` for the same target to apply the correction directly.

Global rules live at `~/.pi/agent/hooks/edit-write.json`. Project rules replace global rules with the same `id`. `WRITE_HOOK_CONFIG` points at a single file for test harnesses.

## Configure

```json
{
  "rules": [
    {
      "id": "markdown-style",
      "when": { "ext": ".md" },
      "exclude": { "basename": "README.md" },
      "instructions": ["Preserve the existing heading hierarchy."],
      "context": [{ "path": "docs/style.md" }]
    }
  ]
}
```

- `when` selectors (`tool`, `path`, `glob`, `ext`, `basename`) combine with AND. A rule with no target selector never matches.
- `exclude` uses the same selector names as a blacklist: when every listed field matches, the rule is skipped.
- A matching rule with no readable instructions and no readable context behaves as nonmatching.
- Hooks must be self-contained. Never write "read file X first": `read` is hidden while a mutation is pending, so inline facts via `instructions` or `context` (max 3 files, ~4 KiB total).

Hand `PI-INSTRUCTIONS.md` to Pi to convert `AGENTS.md` or other rules into hooks. It is a plain instruction file, not a SKILL, so it never pollutes context until you reference it. See [PI-INSTRUCTIONS.md](./PI-INSTRUCTIONS.md).

## Behavior

- Nonmatching target: native tool runs untouched.
- Matching target: staged, no file change, hook text returned.
- `finalize()` on a later turn commits the exact staged arguments.
- Same-target revision on a later turn runs immediately with no second hook round.
- Different-target mutation while pending is blocked; pending survives.
- Same-turn `finalize` or revision is blocked.
- Changed config or context between stage and commit re-shows the hooks.
- Compaction, session reset, and session switch discard pending state.

Validate changes with `npm run typecheck` and `npm test` (or `node --test test/match.test.ts test/config.test.ts` for the matching core).

## Warning

It is very hard to beat default Pi, including `AGENTS.md` or plain hooks, on token efficiency or benchmark scores. Best use is non-code adherence where correctness matters, such as keeping Markdown files, changelogs, or style rules consistent.

## License

MIT as declared in `package.json`.
