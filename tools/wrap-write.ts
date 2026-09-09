// Write wrapper: identical schema and description to native Pi write.
// Only execution is intercepted; passthrough targets run natively untouched.

import { executeMutation, type MutationRuntime, type NativeCall } from "./mutation.ts";

export function createWriteExecute(rt: MutationRuntime) {
  return async (
    toolCallId: string,
    // biome-ignore lint/suspicious/noExplicitAny: native params pass through untouched.
    params: any,
    signal: AbortSignal | undefined,
    // biome-ignore lint/suspicious/noExplicitAny: host callback shape varies by tool.
    onUpdate: any,
    // biome-ignore lint/suspicious/noExplicitAny: full ctx passes through to native.
    ctx: any,
  ) => {
    const call: NativeCall = { toolCallId, signal, onUpdate, ctx };
    return executeMutation("write", params, call, rt);
  };
}
