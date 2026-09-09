// Shared deferred-commit core for the edit/write wrappers and finalize.
// NORMAL targets execute natively untouched. Qualifying first attempts stage
// without mutating and collapse the tool surface to [tool, finalize].

import type { LoadedConfig } from "../hooks/config.ts";
import { matchHooks, resolveTarget, type MutationTool } from "../hooks/match.ts";
import { renderPending, renderRefresh, resolveEffectiveMatch } from "../hooks/render.ts";
import type { PendingState } from "../pending/state.ts";
import { FINALIZE_TOOL, visibleTools } from "../pending/visibility.ts";

export interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

export interface NativeCall {
  toolCallId: string;
  signal: AbortSignal | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: host callback shapes vary by tool.
  onUpdate: any;
  // biome-ignore lint/suspicious/noExplicitAny: only cwd is read; full ctx passes through to native.
  ctx: any;
}

export interface MutationRuntime {
  state: PendingState;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  loadConfig(cwd: string): Promise<LoadedConfig>;
  nativeExecute(tool: MutationTool, args: unknown, call: NativeCall): Promise<TextResult>;
}

function toPosix(relative: string): string {
  return relative.replace(/\\/g, "/").replace(/^\.\//, "");
}

function extractPath(rawArgs: unknown): string | undefined {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;
  const path = (rawArgs as Record<string, unknown>).path;
  return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

function textResult(text: string, details: unknown): TextResult {
  return { content: [{ type: "text" as const, text }], details };
}

function hookEvent(tool: MutationTool, path: string, event: string, state: PendingState): unknown {
  return { writeHook: { event, tool, path, metrics: { ...state.metrics } } };
}

export function restoreSurface(rt: MutationRuntime, restoreActive: string[] | null): void {
  if (restoreActive) {
    rt.setActiveTools(restoreActive);
    return;
  }
  rt.setActiveTools(rt.getActiveTools().filter((name) => name !== FINALIZE_TOOL));
}

export async function executeMutation(
  tool: MutationTool,
  rawArgs: unknown,
  call: NativeCall,
  rt: MutationRuntime,
): Promise<TextResult> {
  const cwd = call.ctx.cwd as string;
  const rawPath = extractPath(rawArgs);
  if (!rawPath) return rt.nativeExecute(tool, rawArgs, call);
  const target = resolveTarget(rawPath, cwd);
  const display = target.relative.length > 0 ? target.relative : rawPath.trim();

  if (rt.state.pending) return executeDuringPending(tool, rawArgs, display, target.absolute, call, rt);

  const loaded = await rt.loadConfig(cwd);
  const matched = matchHooks(loaded.config.rules, tool, toPosix(target.relative));
  if (matched.length === 0) return rt.nativeExecute(tool, rawArgs, call);
  const match = await resolveEffectiveMatch(matched, cwd);
  if (!match.hasEffectiveOutput) return rt.nativeExecute(tool, rawArgs, call);
  if (rt.state.isAcknowledged(tool, target.absolute, match.hookFingerprint, match.contextFingerprint)) {
    return rt.nativeExecute(tool, rawArgs, call);
  }
  return enterPending(tool, rawArgs, display, target.absolute, match, rt);
}

function enterPending(
  tool: MutationTool,
  rawArgs: unknown,
  display: string,
  absolutePath: string,
  match: Awaited<ReturnType<typeof resolveEffectiveMatch>>,
  rt: MutationRuntime,
): TextResult {
  const active = rt.getActiveTools();
  rt.state.enter(
    {
      tool,
      path: display,
      absolutePath,
      args: rawArgs,
      hookFingerprint: match.hookFingerprint,
      contextFingerprint: match.contextFingerprint,
      observedTurn: rt.state.currentTurn,
    },
    active,
  );
  rt.setActiveTools(visibleTools(active, tool));
  return textResult(renderPending(tool, display, match), hookEvent(tool, display, "staged", rt.state));
}

async function executeDuringPending(
  tool: MutationTool,
  rawArgs: unknown,
  display: string,
  absolutePath: string,
  call: NativeCall,
  rt: MutationRuntime,
): Promise<TextResult> {
  const pending = rt.state.pending as NonNullable<PendingState["pending"]>;
  if (tool !== pending.tool || absolutePath !== pending.absolutePath) {
    rt.state.metrics.pendingTargetMismatches += 1;
    return textResult(
      `A ${pending.tool} for ${pending.path} is pending. Finalize it or revise that target first.`,
      hookEvent(tool, display, "target-mismatch", rt.state),
    );
  }
  if (rt.state.currentTurn <= pending.observedTurn) {
    rt.state.metrics.sameTurnDecisionAttempts += 1;
    return textResult(
      `Hook for ${display} was just shown. Finalize or revise on a later turn.`,
      hookEvent(tool, display, "same-turn", rt.state),
    );
  }
  const cwd = call.ctx.cwd as string;
  const loaded = await rt.loadConfig(cwd);
  const matched = matchHooks(loaded.config.rules, tool, toPosix(display));
  if (matched.length === 0) {
    const taken = rt.state.take();
    restoreSurface(rt, taken.restoreActive);
    rt.state.metrics.revisedBeforeCommit += 1;
    return rt.nativeExecute(tool, rawArgs, call);
  }
  const match = await resolveEffectiveMatch(matched, cwd);
  if (
    match.hasEffectiveOutput &&
    match.hookFingerprint === pending.hookFingerprint &&
    match.contextFingerprint === pending.contextFingerprint
  ) {
    const taken = rt.state.take();
    restoreSurface(rt, taken.restoreActive);
    rt.state.metrics.revisedBeforeCommit += 1;
    return rt.nativeExecute(tool, rawArgs, call);
  }
  rt.state.pending = {
    ...pending,
    args: rawArgs,
    hookFingerprint: match.hookFingerprint,
    contextFingerprint: match.contextFingerprint,
    observedTurn: rt.state.currentTurn,
  };
  rt.state.acknowledged = {
    tool,
    absolutePath,
    hookFingerprint: match.hookFingerprint,
    contextFingerprint: match.contextFingerprint,
    observedTurn: rt.state.currentTurn,
  };
  rt.state.metrics.stalePendingInvalidations += 1;
  return textResult(renderRefresh(tool, display, match), hookEvent(tool, display, "refreshed", rt.state));
}
