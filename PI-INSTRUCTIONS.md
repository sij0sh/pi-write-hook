# PI-INSTRUCTIONS.md

Instructions for Pi (the model) when creating or editing write-hook configs.
Human operators can read this too, but it is written so Pi can configure
hooks correctly without guessing.

## Config files

Two layers. Project rules replace global rules with the same `id`.

- Global: `~/.pi/agent/hooks/edit-write.json`
- Project: `<project>/.pi/hooks/edit-write.json`
- Test override: `WRITE_HOOK_CONFIG` points at a single file
  (used by harnesses; prefer the project file for real work).

Shape:

```json
{
  "rules": [
    {
      "id": "esm-sources",
      "when": { "tool": "write", "glob": "src/**/*.ts" },
      "instructions": ["Use ESM imports."],
      "context": [{ "path": "tsconfig.json" }]
    }
  ]
}
```

## Rule fields

- `id` (required, non-empty string): unique per file. A project rule with
  the same `id` as a global rule replaces it entirely.
- `when` (required): positive selectors. All specified selectors must match
  (AND). Available selectors: `tool` (`"edit"` | `"write"`), `path`
  (exact repo-relative path), `glob` (`**`, `*`, `?`), `ext` (with or
  without the dot, case-insensitive), `basename` (exact filename).
- `exclude` (optional): blacklist with the same selector names as `when`.
  If every specified `exclude` selector matches the target (AND), the rule
  is skipped for that target even though `when` matched. An empty or
  selector-less `exclude` never excludes anything.
- `instructions` (optional): strings shown to the model when the rule fires.
  Blank strings are dropped.
- `context` (optional): `[{ "path": "..." }]` files inlined with the hook
  (deduplicated, max 3 files, ~4 KiB total). Missing/blank files are skipped
  silently.

A rule with no `when` target selector (`path`/`glob`/`ext`/`basename`) is
dropped with a warning. A matching rule with no readable instructions and
no readable context behaves as nonmatching (native tool runs untouched).

## Levels: global, file type, filename

There is no separate `level` field. A "level" is just how broad the `when`
selectors are. Multiple rules may match one target; their instructions
concatenate and their context files merge. Layer from broad to narrow:

1. Broad (acts global): `{ "glob": "**/*" }`, optionally with `"tool"`.
2. File type: `{ "ext": ".md" }` or `{ "glob": "**/*.ts" }`.
3. Filename: `{ "basename": "README.md" }` or `{ "path": "docs/README.md" }`.

## Blacklist: keeping a specific file distinct from its type

Because matching is additive, a `README.md` target matches BOTH an
`ext: .md` rule and a `basename: README.md` rule. To give `README.md` its
own rules that are distinct from all other `.md` files, blacklist it on the
broader rule with `exclude`:

```json
{
  "rules": [
    {
      "id": "markdown",
      "when": { "ext": ".md" },
      "exclude": { "basename": "README.md" },
      "instructions": ["Preserve the existing heading hierarchy."]
    },
    {
      "id": "readme",
      "when": { "basename": "README.md" },
      "instructions": ["Treat this as user-facing project documentation."]
    }
  ]
}
```

Result: `docs/guide.md` gets the markdown instructions;
`README.md` (anywhere) gets only the readme instructions.

More `exclude` patterns (all AND within one `exclude`):

- One directory tree: `"exclude": { "glob": "src/drafts/**" }`
- One exact file: `"exclude": { "path": "docs/notes.md" }`
- One type: `"exclude": { "ext": ".mdx" }`
- One tool: `"exclude": { "tool": "edit" }` (rule fires for `write` only)
- Narrow the blacklist: `"exclude": { "basename": "README.md", "glob": "docs/**" }`
  skips only `docs/README.md`, not every `README.md`.

To blacklist several unrelated targets from one rule, prefer splitting the
broad rule into narrower rules rather than overloading one `exclude`.

## Writing good hook content

- Hooks must be self-contained: instructions plus included context. Never
  write fetch directives such as "read tsconfig.json first" or "check the
  docs" — `read` and friends are hidden while a mutation is pending, so the
  model cannot fetch anything. Put the fact in `instructions` or inline the
  file via `context`.
- Keep each instruction one actionable sentence. Three short sentences beat
  one long paragraph.
- Prefer `ext`/`basename` over `glob` when a simple selector fits; reserve
  `glob` for directory scoping (`docs/**`, `src/**/*.ts`).
- `context` is for small stable references (configs, style guides), not for
  the target file itself and not for recursion (context files never trigger
  their own rules).

## After editing config

1. `npm run typecheck`
2. `npm test` (or at least the touched area:
   `node --test test/match.test.ts test/config.test.ts`)
3. If a rule misfires, check in order: `when` selectors (AND — one wrong
   field blocks everything), `exclude` (AND — all listed fields must match
   to skip), `tool` mismatch, `ext` dot/case, `glob` `*` vs `**`, then
   whether the rule actually produced output (blank instructions/context =
   nonmatching).
