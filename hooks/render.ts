// Minimal pending-result rendering. Only new information reaches the model:
// one status line, hook instructions, up to 3 included files, ~6 KiB total cap.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HookRule } from "./config.ts";
import { fingerprintContext, fingerprintHook } from "./fingerprint.ts";

export const MAX_CONTEXT_FILES = 3;
export const MAX_INSTRUCTIONS_CHARS = 2048;
export const MAX_CONTEXT_CHARS = 4096;

export interface LoadedContextFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface EffectiveMatch {
  rules: HookRule[];
  instructions: string[];
  contextFiles: LoadedContextFile[];
  hookFingerprint: string;
  contextFingerprint: string;
  hasEffectiveOutput: boolean;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit) + "\n[truncated]", truncated: true };
}

async function loadContextFile(displayPath: string, cwd: string): Promise<LoadedContextFile | undefined> {
  try {
    const raw = await readFile(resolve(cwd, displayPath), "utf-8");
    if (!raw.trim()) return undefined;
    return { path: displayPath, content: raw, truncated: false };
  } catch {
    return undefined;
  }
}

export async function resolveEffectiveMatch(
  rules: HookRule[],
  cwd: string,
): Promise<EffectiveMatch> {
  const instructions: string[] = [];
  for (const rule of rules) {
    for (const line of rule.instructions ?? []) instructions.push(line);
  }
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const rule of rules) {
    for (const include of rule.context ?? []) {
      if (!seen.has(include.path) && wanted.length < MAX_CONTEXT_FILES) {
        seen.add(include.path);
        wanted.push(include.path);
      }
    }
  }
  const contextFiles: LoadedContextFile[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const path of wanted) {
    if (remaining <= 0) break;
    const loaded = await loadContextFile(path, cwd);
    if (!loaded) continue;
    const cut = truncate(loaded.content, remaining);
    remaining -= cut.text.length;
    contextFiles.push({ path, content: cut.text, truncated: cut.truncated });
  }
  const cappedInstructions = truncate(instructions.map((line) => `- ${line}`).join("\n"), MAX_INSTRUCTIONS_CHARS);
  const instructionLines = cappedInstructions.text.length > 0 ? cappedInstructions.text : "";
  return {
    rules,
    instructions: instructionLines.length > 0 ? instructionLines.split("\n") : [],
    contextFiles,
    hookFingerprint: fingerprintHook(instructions),
    contextFingerprint: fingerprintContext(contextFiles.map((f) => ({ path: f.path, content: f.content }))),
    hasEffectiveOutput: instructions.length > 0 || contextFiles.length > 0,
  };
}

export function renderPending(
  tool: "edit" | "write",
  displayPath: string,
  match: EffectiveMatch,
): string {
  const parts = [`Pending ${tool} for ${displayPath}. No file changed.`, ""];
  if (match.instructions.length > 0) parts.push(match.instructions.join("\n"), "");
  for (const file of match.contextFiles) {
    parts.push(`Relevant ${file.path}:`, file.content, "");
  }
  parts.push(`Finalize to apply the pending ${tool} unchanged, or use ${tool} to revise it.`);
  return parts.join("\n");
}

export function renderRefresh(
  tool: "edit" | "write",
  displayPath: string,
  match: EffectiveMatch,
): string {
  const parts = [`Hook context changed since this mutation was reviewed. Pending ${tool} for ${displayPath} remains unapplied.`, ""];
  if (match.instructions.length > 0) parts.push(match.instructions.join("\n"), "");
  for (const file of match.contextFiles) {
    parts.push(`Relevant ${file.path}:`, file.content, "");
  }
  parts.push(`Finalize to apply the pending ${tool} unchanged, or use ${tool} to revise it.`);
  return parts.join("\n");
}
