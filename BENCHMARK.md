# Benchmarks: write-hook under roastmyharness, with the aftermarket-tools lineage

Version under test: write-hook `0.1.0` (Pi 0.85.1, `gpt-5.6-luna`).
Data: `~/.local/share/roastmyharness/runs/` plus per-trial `pi-events.jsonl` traces.
Reference project: `/home/joshsimon/Projects/pi-extensions/aftermarket-tools/`.

## Verdict up front

- Dormant footprint is real and verified: with no delivered config the extension
  is statistically indistinguishable from bare Pi.
- Active footprint is not small: every first-touch edit costs one extra model
  turn, and measured cache workload rose 20-101%.
- Instruction adherence in the only valid active A/B was 0/79: the agent never
  re-read before finalizing and finalized unchanged every single time.
- The larger 12-trial benchmark is invalid as a hook test: a config delivery bug
  left the hook dormant, so it measured control vs control.
- On current evidence, deferred-commit staging carries generic hygiene rules
  at pure cost. It only has a chance when the hook carries facts the agent
  does not already have (live checks), which is the shipped `trigger: "check"`
  design - itself still unvalidated by any run.

## Run inventory (write-hook)

| Run | Design | Result | Validity |
|---|---|---|---|
| `roast-20260908t195202` | kombu, low, 1 rep | FAILED: control config error (`control mode = historic but no task has 4 observations`) | infra |
| retry of same | kombu, low | CANCELLED after 1 control trial; spec also set no `WRITE_HOOK_CONFIG`, so the arm would have been dormant | infra |
| `roast-ts-pattern` | ts-pattern, low, 1 rep | both arms 0/1; hook fired (2 stage, 2 finalize) | valid, n=1, no signal |
| `roast-20260908t213349` | 3 tasks x 2 reps, high, 12 trials | control 4/6, write-hook 3/6; cost ratio 0.88-1.0x | INVALID as hook test (see below) |
| `roast-20260908t233449` | 3 pre-sampled tasks, high, 6 trials | control 3/3, write-hook 0/3 | valid, the only real A/B |

The planned 12-trial `roast-hook-3x` benchmark (vulture/httpx/wazero, described
in CHEATCODES as the delivery contract) never ran: no experiment and no run
directory exist.

## The delivery bug that voided the 12-trial run

`roast-20260908t213349` pointed `WRITE_HOOK_CONFIG` at the host path
(`/home/joshsimon/.../roast-hooks/edit-write-polyglot.json`). The harness copies
the extension into the container at `/opt/pi-home/extensions/write-hook/`, so the
config path did not exist in-container and loading failed open to zero rules.
Proof from traces: 40+ edit calls to `.ts` files across 6 trials, zero
`Pending` outputs, zero `finalize` calls. The arm was a second control.

The twin run `roast-20260908t233449` used the container path and staged 79/79
matching first-touch edits, which confirms delivery is the only difference.

This is the same failure mode already documented in the aftermarket campaign
(`roast-20260907t013755-analysis.md`, run 1: `AFTERMARKET_TOOLS_PRETOOL_DIR` set
to a host path, silently skipped, arm excluded). The mistake has now invalidated
one arm in each project. Both times the failure was silent because missing
config fails open by design.

Consequences:

- Treat the 4/6 vs 3/6 outcome as noise between two controls, not as a hook
  result. Its cost ratios (0.88x calls, 0.85x cache) do not measure the hook.
- CHEATCODES currently describes `roast-20260908t213349` as a valid write-hook
  comparison. It is not, and the entry should be corrected.
- Recommendation: log config-load status (`file, rules, effective`) into result
  details at session start, and have specs assert hook firings > 0 when the
  hypothesis needs them. A benchmark arm that never fires must fail loudly.

## The valid active A/B: `roast-20260908t233449`

Three tasks where control (bare Pi, thinking high) previously partially solved:
bandit, pebble, valibot. One repetition per arm. Hook: edit-only polyglot
hygiene rule ("Re-read what you just changed. Run the full tests after the last
edit. Do not commit on red tests.") on `**/*.py`, `**/*.go`, `**/*.ts`.

### Correctness

| Task | Control | Write-hook | Near-miss detail |
|---|---|---|---|
| bandit-incremental-cache-control | 1/1 (F2P 88/88) | 0/1 | F2P 87/88, missed `cache_stats_shows_cache_file_size_bytes` |
| pebble-durability-wait-apis | 1/1 | 0/1 | F2P 57/59, two sync-failure-path tests |
| valibot-recursive-schema-composition | 1/1 | 0/1 | F2P 2/10, `recursive is not a function` (broken export wiring) plus tsc gate |
| total | 3/3 | 0/3 | |

All three write-hook trials were near-misses, not collapses. At n=3 the -100pp
gap is a loud negative signal, not a measured effect size. The mechanism below
is the reusable finding.

### Footprint to the Pi session (paired)

| Metric | bandit | pebble | valibot |
|---|---|---|---|
| hook firings (staged = finalized) | 13 | 22 | 44 |
| LLM steps, control -> hook | 51 -> 65 (+12%) | 91 -> 128 (+41%) | 130 -> 197 (+52%) |
| cache tokens, control -> hook | 2.32M -> 2.96M (+27%) | 8.19M -> 9.81M (+20%) | 9.50M -> 19.12M (+101%) |
| wall, control -> hook | 521s -> 544s | 1542s -> 1576s | 1354s -> 1983s (+46%) |
| extra steps per firing | 0.6 | 1.7 | 1.5 |
| cache overhead per firing | ~48k | ~74k | ~218k |

Reading:

- The hook costs one minimum extra model turn per firing (the `finalize` round
  trip), and each extra turn re-reads the accumulated context from cache. That
  is the 20-101% cache inflation.
- The pending text itself is cheap (observed ~250 chars with a 3-instruction
  rule; hard cap ~6 KiB). Turns, not bytes, are the cost.
- The tool surface collapses while pending to `[edit|write, finalize]`, hiding
  read/grep/bash. Per the design, hooks must be self-contained because of this.
- Cross-tool envelope confusion (bash args sent to `edit`, write args sent to
  `edit`) appeared twice in the write-hook valibot trial. Native controls also
  confuse (read args sent to `edit`, once per control trial in pebble and
  valibot). Confusion is a native failure class (52% of failed bare-Pi trials
  per the aftermarket pitfalls study), not caused by the hook, but the extra
  state and turns give it more room.

### Instruction adherence

Trace-derived, all staged mutations in the active run:

| Rule | Adherence |
|---|---|
| "Re-read what you just changed" before deciding | 0/79 (0%) |
| Finalize unchanged (no revision) | 79/79 (100%) |
| Revise before commit | 0/79 |

Stage was followed by zero-arg `finalize` on the immediately next turn in
essentially every case, with no intervening read of the target. The deferred
round trip never changed the content it gated. By write-hook's own spec section
20 economy metric (`finalizedUnchanged / hookedFirstAttempts = 1.0`), the
architecture failed its validation purpose in this configuration.

Why: the staged content is the agent's own just-composed edit. A generic
hygiene instruction adds no information between composing and confirming, so
the confirmation degenerates into a mandatory extra tap. Deferred-commit can
only earn its turn when the hook text contains something the model cannot
already infer - a live line count, an ASCII offset, a style-scan hit - which is
exactly the `checks` + `trigger: "check"` design. The benchmarked config used
static instructions only, the weakest case.

## Footprint by mode (summary)

| Mode | Session footprint | Evidence |
|---|---|---|
| No effective hooks | none registered; byte-identical native surface | design tests (74 passing) + dormant arm in 213349 indistinguishable from control |
| Hooks loaded, target nonmatching | native execution, zero extra calls; harvested native schemas | trace: nonmatching writes ran directly in 233449 |
| Target matches, static instructions | +1 turn per first-touch target; surface collapse while pending; +20-101% cache | 233449 table above |
| Target matches, check-gated | same cost shape, but fires only when a check warns/blocks | shipped but never benchmarked |

## The aftermarket-tools lineage

aftermarket-tools is the parent research line. Its early staged versions are
the "major tool call issues" era, and its artifacts quantify them.

### Iteration 1: staged five-tool system (0.2.0)

Two-phase mutation protocol (prepare, then execute next turn). 11 paired live
trials vs bare Pi (BENCHMARK.md): median 2.20x total input cost, geometric mean
~2.06x, staged cheaper in 1/11, above 2x in 6/11. Later handshake isolation:
removing the handshake still left the staged family at 0/35 resolved vs control
3/35, with the handshake only ~20% of staged cost.

The tool call issues the runtime had to absorb (from BENCHMARK.md and the
0.5.1/0.5.2 roast analyses): unprepared `edit({path, edits})` drafts on the
native schema, empty edits, stale anchors on retry (2 failed prepared executions
in one go-git trial), 11 vs 3 tool errors vs control, and ~3.9x input cost in
error-recovery cache loops. Per-family: Tengo pinned at 1/91 F2P in every
staged cell (single-file narrowing: staged touched only `compiler.go`, +9-18
lines, vs native +57-83 across parser/compiler/VM); Obsidian 0/60 once; Wazero
misses replicated. Verdict: research line concluded, general replacement
rejected.

### Iteration 2: hooks / related-context (0.5.2) - the direct ancestor

aftermarket hooks are write-hook's rule format in embryo: match on target path,
inject instructions and related-context files. The go-git A/B (8 runs, 11
trials) found: delivery 7/7 when triggered (~1.3 KiB per preparation), but
exposure sporadic (the agent did not always touch the hooked file), and scores
of hook 17/85 vs baseline 16/102 vs control 27/102 - no gain, worse than
control. Component disposition later: "target-conditioned policies/hooks: keep
optional", detached from mandatory staging.

Two transferable lessons: (1) delivery must use the container path (run 1 was
voided by the host-path bug write-hook later repeated); (2) injecting context
on target match does not by itself change outcomes - exposure and content
quality dominate.

### Iteration 3: successor - native edit/write plus invisible safeguards

The opposite resolution of the same problem: keep the native one-call workflow,
add safeguards that never change the model-facing surface (queue, recheck,
overlap rejection, syntax gate, atomic write). Results:

| Gate | 5x2 screen | 12x2 confirmation |
|---|---|---|
| Correctness | 7/10 vs control 6/10 | 13/24 vs 12/24 |
| LLM calls | 1.01x | 1.046x |
| Workload | 1.04x (median 0.99x) | 1.146x (band edge) |
| Wall | 0.84x | 1.073x |
| Friction | +6 successor-specific rejections over 20 trials, 16/19 retry-recovered | 42/405 rejections (9.4%), 88% retry-recovered, `fuzzy-would-accept` 0 |

Verdict: non-inferiority passed. Prevention value in ordinary use remained
undemonstrated after ~600 attempts (syntax gate fired 4x naturally, all
recovered; stale/race/binary/symlink/queue never fired).

### What the lineage says about write-hook

| Property | aftermarket staged | aftermarket hooks | aftermarket successor | write-hook deferred-commit |
|---|---|---|---|---|
| Workflow change | +1 turn per mutation | none (context rides preparations) | none | +1 turn per firing |
| Measured cost | ~2.06x median | ~1x (no gain) | 1.01-1.15x | +20-101% cache when active |
| Correctness effect | negative to neutral | zero | non-inferior, +1 in both screens | 0/3 vs 3/3 (n=3) |
| Adherence burden | model had to pre-declare | model had to touch hooked file | none | model must re-read; adherence 0% |

The successor's hard gate - "ordinary successful operations require no
additional LLM turn" - is precisely the gate write-hook's active mode fails by
design whenever it fires. The aftermarket campaign tested workflow-changing and
workflow-preserving designs head to head on the same harness; the
workflow-preserving one passed and the workflow-changing one failed. write-hook
reintroduces a workflow change as its core mechanism, and its first valid A/B
behaved as the lineage predicts.

## Conclusions

1. Dormancy works. No config, no trace, no cost - verified in live trials, not
   just unit tests. This is the strongest empirical claim in the repo.
2. The active mode's cost is turns, and its measured cache footprint is 1.2-2x
   per task at thinking high. The README's "context cost stays near zero" holds
   only for the pending text bytes, not for the extra turn's cache re-read.
3. Static-instruction hooks have 0% observed adherence value: the agent always
   finalizes unchanged. A round trip that never changes its outcome is noise
   with latency, and it degraded solve rate 0/3 vs 3/3 on the sampled tasks.
4. Two of four write-hook runs are unusable (infra, delivery), and one valid
   run has n=3. No current evidence supports a benefit claim; the README's
   "vetted with roastmyharness" should not be read as a positive A/B result.
5. The delivery footgun (host vs container path, silent fail-open) has now
   invalidated arms in two projects. Add config-load telemetry and a
   firings-greater-than-zero assertion to benchmark specs.
6. The promising path is the one already shipped but unmeasured: check-gated
   rules (`trigger: "check"`) that stage only when a scan finds a real
   violation with live facts (size over 500, non-ASCII offset). Those give the
   finalize decision actual content. Until a run shows adherence above zero and
   cost near native on check-gated configs, static-instruction staging should
   be considered a cost, not a feature.
7. Benchmark hygiene: the 12-trial run demonstrates that a dormant arm can
   produce plausible-looking neutral results. Any write-hook benchmark report
   should include staged/finalize counts as a delivery proof.

## Live validation while writing this document

The global deployment fired on this very file. The `write` staged, the style
check ran, and the result showed the rules plus five signals. This matches the
check-gated flow the benchmark never exercised: the reminder carried live facts
(five scanned signals), not static advice.

Closer inspection showed all five signals shared one cause: the check counted a
whole Markdown table as one sentence of 94, 99, 61, 53, and 52 words. Table rows
contain no sentence boundaries, and the masker skipped them. Fix: `mask()` now
excludes table rows like fences and blockquotes (`checks/style.mjs`, deployed to
`~/.pi/agent/write-hook/checks/`, re-run on this file: pass). The edit to the
check itself also staged once under the comment rule; its added comment states
the masking constraint, so finalize was correct there.

This session is the adherence counterexample to the benchmark agents: stage,
inspect the signal, fix the cause, then commit. It cost one extra turn per
mutation and changed the content both times. That is the shape check-gated
hooks must show in a future roast run.

## Reproducing

- Run data: `~/.local/share/roastmyharness/runs/<run-id>/summary.json`,
  `analysis.json`, and `jobs/<variant>/<job>/<task>*/agent/pi-events.jsonl`.
- Trace scans used: tool-call classification by `tool_execution_start/end`
  pairs; staging detected by outputs starting `Pending`; adherence by checking
  for an intervening `read` of the pending target between stage and `finalize`;
  delivery proof by comparing `Pending` counts against config path per run.
- Specs: `write-hook/.pi-files/roastmyharness/*.toml`;
  `aftermarket-tools` campaign specs in its `.pi-files/roastmyharness/`.
