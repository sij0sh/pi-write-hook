// Write-hook extension entry: deferred-commit hooks for native edit/write.
// No effective hooks configured means nothing is registered and Pi behaves
// exactly like base Pi. Otherwise edit/write keep their native definitions
// and only execution is wrapped; finalize exists solely while pending.

import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasEffectiveHooks, loadConfig } from "./hooks/config.ts";
import { PendingState } from "./pending/state.ts";
import { FINALIZE_TOOL } from "./pending/visibility.ts";
import { executeFinalize } from "./tools/finalize.ts";
import type { MutationRuntime, NativeCall } from "./tools/mutation.ts";
import { createEditExecute } from "./tools/wrap-edit.ts";
import { createWriteExecute } from "./tools/wrap-write.ts";

export default function writeHook(pi: ExtensionAPI): void {
  const state = new PendingState();
  let toolsRegistered = false;

  const rt: MutationRuntime = {
    state,
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names: string[]) => pi.setActiveTools(names),
    loadConfig: (cwd: string) => loadConfig(cwd),
    nativeExecute: async (tool, args, call: NativeCall) => {
      const definition =
        tool === "edit" ? createEditToolDefinition(call.ctx.cwd) : createWriteToolDefinition(call.ctx.cwd);
      return (definition.execute as (...execArgs: unknown[]) => Promise<never>)(
        call.toolCallId,
        args,
        call.signal,
        call.onUpdate,
        call.ctx,
      ) as Promise<never> as ReturnType<MutationRuntime["nativeExecute"]>;
    },
  };

  pi.on("turn_start", (event) => {
    state.setTurn(event.turnIndex);
  });

  pi.on("session_start", async (_event, ctx) => {
    state.clearAll();
    state.setTurn(0);
    const loaded = await loadConfig(ctx.cwd);
    for (const warning of loaded.warnings) console.warn(`[write-hook] ${warning}`);
    if (!hasEffectiveHooks(loaded.config)) return;
    if (!toolsRegistered) {
      registerOverrides(ctx.cwd);
      toolsRegistered = true;
    }
    hideFinalize();
  });

  const resetTransaction = (): void => {
    const restore = state.restoreActive;
    state.clearAll();
    try {
      if (restore) pi.setActiveTools(restore);
      else hideFinalize();
    } catch {
      // Host is tearing down; nothing to restore.
    }
  };

  pi.on("session_shutdown", () => resetTransaction());
  pi.on("session_compact", () => resetTransaction());
  pi.on("session_tree", () => resetTransaction());

  function hideFinalize(): void {
    try {
      const active = pi.getActiveTools();
      if (active.includes(FINALIZE_TOOL)) {
        pi.setActiveTools(active.filter((name) => name !== FINALIZE_TOOL));
      }
    } catch {
      // Tools are not ready yet; finalize stays hidden by default.
    }
  }

  function registerOverrides(cwd: string): void {
    const editDefinition = createEditToolDefinition(cwd) as unknown as Record<string, unknown>;
    const writeDefinition = createWriteToolDefinition(cwd) as unknown as Record<string, unknown>;
    const { renderCall: _editCall, renderResult: _editResult, ...editRest } = editDefinition;
    const { renderCall: _writeCall, renderResult: _writeResult, ...writeRest } = writeDefinition;
    pi.registerTool({
      ...(editRest as object),
      name: "edit",
      execute: createEditExecute(rt),
      // biome-ignore lint/suspicious/noExplicitAny: harvested native definition shape.
    } as any);
    pi.registerTool({
      ...(writeRest as object),
      name: "write",
      execute: createWriteExecute(rt),
      // biome-ignore lint/suspicious/noExplicitAny: harvested native definition shape.
    } as any);
    pi.registerTool({
      name: FINALIZE_TOOL,
      label: "Finalize",
      description: "Apply the pending mutation exactly as submitted.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(toolCallId, _params, signal, _onUpdate, ctx) {
        return executeFinalize({ toolCallId, signal, onUpdate: undefined, ctx }, rt);
      },
    });
    hideFinalize();
  }
}
