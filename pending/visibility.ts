// Tool visibility is a pure function of pending state.
// NORMAL renders the base surface untouched; PENDING shows only the
// intercepted native tool plus finalize.

import type { MutationTool } from "../hooks/match.ts";

export const FINALIZE_TOOL = "finalize";

export function visibleTools(
  baseActive: string[],
  pendingTool: MutationTool | null,
): string[] {
  if (!pendingTool) return [...baseActive];
  return [pendingTool, FINALIZE_TOOL];
}
