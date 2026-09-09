// Zero-arg commit for the staged mutation. Revalidates hook context, then
// clears the transaction before executing so native failure semantics survive.

import { matchHooks, resolveTarget } from "../hooks/match.ts";
import { renderRefresh, resolveEffectiveMatch } from "../hooks/render.ts";
import { restoreSurface, type MutationRuntime, type NativeCall, type TextResult } from "./mutation.ts";

function toPosix(relative: string): string {
  return relative.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function executeFinalize(call: NativeCall, rt: MutationRuntime): Promise<TextResult> {
  const pending = rt.state.pending;
  if (!pending) {
    return {
      content: [{ type: "text" as const, text: "No mutation is pending." }],
      details: { writeHook: { event: "finalize-empty", metrics: { ...rt.state.metrics } } },
    };
  }
  if (rt.state.currentTurn <= pending.observedTurn) {
    rt.state.metrics.sameTurnDecisionAttempts += 1;
    return {
      content: [{ type: "text" as const, text: `Hook for ${pending.path} was just shown. Finalize on a later turn.` }],
      details: { writeHook: { event: "same-turn", tool: pending.tool, path: pending.path } },
    };
  }
  const cwd = call.ctx.cwd as string;
  const loaded = await rt.loadConfig(cwd);
  const matched = matchHooks(loaded.config.rules, pending.tool, toPosix(resolveTarget(pending.path, cwd).relative));
  if (matched.length === 0) return commit(rt, pending.tool, pending.args, call);
  const match = await resolveEffectiveMatch(matched, cwd);
  if (!match.hasEffectiveOutput) return commit(rt, pending.tool, pending.args, call);
  if (
    match.hookFingerprint === pending.hookFingerprint &&
    match.contextFingerprint === pending.contextFingerprint
  ) {
    return commit(rt, pending.tool, pending.args, call);
  }
  rt.state.pending = {
    ...pending,
    hookFingerprint: match.hookFingerprint,
    contextFingerprint: match.contextFingerprint,
    observedTurn: rt.state.currentTurn,
  };
  rt.state.acknowledged = {
    tool: pending.tool,
    absolutePath: pending.absolutePath,
    hookFingerprint: match.hookFingerprint,
    contextFingerprint: match.contextFingerprint,
    observedTurn: rt.state.currentTurn,
  };
  rt.state.metrics.stalePendingInvalidations += 1;
  return {
    content: [{ type: "text" as const, text: renderRefresh(pending.tool, pending.path, match) }],
    details: { writeHook: { event: "refreshed", tool: pending.tool, path: pending.path } },
  };
}

function commit(
  rt: MutationRuntime,
  tool: "edit" | "write",
  args: unknown,
  call: NativeCall,
): Promise<TextResult> {
  const taken = rt.state.take();
  restoreSurface(rt, taken.restoreActive);
  rt.state.metrics.finalizedUnchanged += 1;
  return rt.nativeExecute(tool, args, call);
}
