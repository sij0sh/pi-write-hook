# Benchmarks: write-hook under roastmyharness

Version under test: write-hook `0.1.0` (Pi 0.85.1, `gpt-5.6-luna`).
Data: `~/.local/share/roastmyharness/runs/` plus per-trial `pi-events.jsonl` traces.

## Verdict up front

- Dormant means dormant: with no delivered config the extension is
  indistinguishable from bare Pi.
- The tested config is the worst case: static instructions on every
  first-touch edit. It adds about one extra model turn per firing.
- Two of three active trials sit inside normal model noise. One long
  trial stands outside it.
- The agent never re-read before finalizing in this config (0/79).
  The round trip added cost without changing content.
- The shipped design avoids this cost: rules with `trigger: "check"`
  stage only when a live check finds a violation. That path was never
  benchmarked, but it fires far less often by construction.

## What normal variation looks like

The Luna High baseline pools 203 high-thinking trials across 49 tasks.
Mean total consumption is 4.86M tokens. Sigma is 4.44M tokens.
This file uses that whole-population sigma as the yardstick.

Rule used here: a control-to-hook swing under one sigma (about 4.4M
tokens) counts as standard model variance. A swing above it counts as
a real overhead signal. This avoids over-reading per-task bands built
from one or two samples.

## Run inventory

| Run | Design | Result | Validity |
|---|---|---|---|
| `roast-20260908t195202` | kombu, low, 1 rep | FAILED: control config error | infra |
| retry of same | kombu, low | CANCELLED after 1 control trial; arm would have been dormant | infra |
| `roast-ts-pattern` | ts-pattern, low, 1 rep | both arms 0/1; hook fired (2 stage, 2 finalize) | valid, n=1, no signal |
| `roast-20260908t213349` | 3 tasks x 2 reps, high, 12 trials | control 4/6, write-hook 3/6 | INVALID as hook test (see below) |
| `roast-20260908t233449` | 3 pre-sampled tasks, high, 6 trials | control 3/3, write-hook 0/3 | valid, the only real A/B |

## The delivery bug that voided the 12-trial run

`roast-20260908t213349` pointed `WRITE_HOOK_CONFIG` at a host path.
The harness copies the extension into the container, so the path did
not exist in-container. Loading failed open to zero rules.

Proof from traces: 40+ edit calls to `.ts` files across 6 trials,
zero `Pending` outputs, zero `finalize` calls. The arm was a second
control. The twin run `roast-20260908t233449` used the container path
and staged 79/79 matching first-touch edits.

Consequences:

- Treat 4/6 vs 3/6 as noise between two controls, not as a hook result.
- Any benchmark arm that never fires must fail loudly. Specs should
  assert hook firings above zero when the hypothesis needs them.

## The valid active A/B: `roast-20260908t233449`

Three tasks where bare Pi previously solved: bandit, pebble, valibot.
One repetition per arm. Hook: edit-only hygiene rule ("Re-read what
you just changed. Run the full tests after the last edit. Do not
commit on red tests.") on `**/*.py`, `**/*.go`, `**/*.ts`.

### Correctness

| Task | Control | Write-hook | Near-miss detail |
|---|---|---|---|
| bandit-incremental-cache-control | 1/1 (F2P 88/88) | 0/1 | F2P 87/88, one cache-size test |
| pebble-durability-wait-apis | 1/1 | 0/1 | F2P 57/59, two sync-path tests |
| valibot-recursive-schema-composition | 1/1 | 0/1 | F2P 2/10, broken export wiring plus tsc gate |
| total | 3/3 | 0/3 | |

All three hook trials were near-misses, not collapses. At n=3 the gap
is a loud negative signal, not a measured effect size.

### Footprint to the Pi session (paired)

| Metric | bandit | pebble | valibot |
|---|---|---|---|
| hook firings (staged = finalized) | 13 | 22 | 44 |
| LLM steps, control -> hook | 51 -> 65 | 91 -> 128 | 130 -> 197 |
| cache tokens, control -> hook | 2.32M -> 2.96M (+0.64M) | 8.19M -> 9.81M (+1.62M) | 9.50M -> 19.12M (+9.62M) |
| wall, control -> hook | 521s -> 544s | 1542s -> 1576s | 1354s -> 1983s (+46%) |

Reading against the 4.44M sigma yardstick:

- Bandit (+0.64M) sits well inside one sigma. Classify as standard
  model variance.
- Pebble (+1.62M) sits well inside one sigma. Classify as standard
  model variance.
- Valibot (+9.62M, about 2.2 sigma) stands outside it. This is the
  only real overhead signal. Extra turns re-read accumulated context
  from cache, so cost grows with session length.

The pending text itself is cheap (about 250 chars with a short rule;
hard cap near 6 KiB). Turns, not bytes, drive cost.

### Instruction adherence

Trace-derived, all staged mutations in the active run:

| Rule | Adherence |
|---|---|
| "Re-read what you just changed" before deciding | 0/79 (0%) |
| Finalize unchanged (no revision) | 79/79 (100%) |
| Revise before commit | 0/79 |

Stage was followed by zero-arg `finalize` on the next turn in nearly
every case, with no read of the target in between. The staged content
was the agent's own just-composed edit. A generic reminder adds no new
fact between composing and confirming, so the confirmation becomes a
mandatory extra tap.

## Footprint by mode

This is how the numbers above pertain to the extension as shipped.

| Mode | Session footprint | Evidence |
|---|---|---|
| No effective hooks | none; registers nothing | design tests (74 passing) plus dormant arm in 213349 |
| Hooks loaded, target nonmatching | native run, zero extra calls | nonmatching writes ran directly in 233449 |
| Target matches, static instructions | about one extra turn per first touch | 233449 table above; worst case, fires 79/79 |
| Target matches, check-gated | same shape, but fires only on check warn or block | shipped default; never benchmarked |

The benchmark measured only the third row. The fourth row is what
ships as the recommended pattern.

## Alternative solutions to the same problem

Three earlier approaches tried to fix the same miss: the agent skips
a rule it already saw. Each used a different technique.

- Prepare-then-execute: the agent had to declare each mutation one
  turn before running it. Technique differs by changing every
  mutation into two turns. A/B consequence: median cost near 2x
  control with no correctness gain. Rejected.
- Target-matched context injection: touching a watched file injected
  extra instructions and files, with no workflow change. Technique
  differs by adding context without gating. A/B consequence: scores
  stayed flat or slightly below control. No gain.
- Invisible safeguards on native tools: the one-call edit flow stayed,
  with silent gates for overlap, syntax, and races. Technique differs
  by never adding a turn for clean operations. A/B consequence: cost
  near 1.01-1.15x control with correctness held. Passed.

Write-hook keeps the native flow for everything except a matched
target, and its check-gated mode keeps even matched targets native
unless a live scan fires. That is why its ordinary footprint is the
smallest of the set: zero when dormant, zero on nonmatching targets,
and rare gated interruptions instead of a tax on every operation.

## Conclusions

1. Dormancy works. No config means no trace and no cost.
2. Static instructions on every match cost about one turn per firing.
   Two of three measured swings sit inside normal Luna High variance.
   The third shows how extra turns compound on long sessions.
3. A round trip that never changes its outcome is cost without value.
   Static staging scored 0/79 adherence here.
4. Sample size is small (n=3 valid) and two of four runs are unusable.
   No benefit claim follows from current evidence.
5. The delivery footgun (host vs container path, silent fail-open)
   voids arms silently. Log config-load status and require firings
  above zero in benchmark specs.
6. The promising path is already shipped but unmeasured: check-gated
   rules that carry live facts (a line count, a scan hit). Until a run
   shows adherence above zero with cost near native, treat static
   staging as a cost, not a feature.
7. Benchmark hygiene: a dormant arm can produce neutral-looking
   results. Always report staged and finalize counts as delivery proof.

## Live validation while writing this document

The global deployment fired on this very file. The `write` staged,
the style check ran, and the pending text carried five live signals.
That matches the check-gated flow the benchmark never exercised.

Closer inspection showed all five signals shared one cause: the check
counted a whole Markdown table as one long sentence. Fix: `mask()` now
excludes table rows like fences and blockquotes (`checks/style.mjs`).
Re-run on this file passes. The edit changed content both times at a
cost of one extra turn each. That is the shape check-gated hooks must
show in a future roast run.

## Reproducing

- Run data: `~/.local/share/roastmyharness/runs/<run-id>/summary.json`,
  `analysis.json`, and `jobs/<variant>/<job>/<task>*/agent/pi-events.jsonl`.
- Trace scans used: tool-call classification by `tool_execution_start/end`
  pairs; staging detected by outputs starting `Pending`; adherence by checking
  for an intervening `read` of the pending target between stage and `finalize`;
  delivery proof by comparing `Pending` counts against config path per run.
- Specs: `write-hook/.pi-files/roastmyharness/*.toml`.
- Baseline norms: Luna High mean 4.86M total tokens, sigma 4.44M, from the
  RoastMyHarness benchmark log token-baseline section.
