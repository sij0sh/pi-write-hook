import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HookRule } from "./config.ts";
import type { MutationTool } from "./match.ts";

export const CHECKS_DIR_NAME = "write-hook/checks";
export const MAX_CHECKS = 3;
export const CHECK_TIMEOUT_MS = 5000;
export const MAX_CHECK_MESSAGE_CHARS = 500;
export const MAX_CHECK_TOTAL_CHARS = 2048;

export type CheckVerdict = "pass" | "warn" | "block";
export type CheckPhase = "pre" | "post";

export interface CheckInput {
  phase: CheckPhase;
  tool: MutationTool;
  cwd: string;
  relativePath: string;
  absolutePath: string;
  stagedContent?: string;
  diskContent?: string | null;
}

export interface CheckSummary {
  messages: string[];
  blocked?: string;
  triggered: boolean;
}

function truncate(message: string): string {
  return message.length <= MAX_CHECK_MESSAGE_CHARS ? message : message.slice(0, MAX_CHECK_MESSAGE_CHARS);
}

export function collectCheckNames(rules: HookRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    for (const name of rule.checks ?? []) {
      if (!out.includes(name) && out.length < MAX_CHECKS) out.push(name);
    }
  }
  return out;
}

export function resolveCheckFile(name: string, cwd: string): string | undefined {
  const file = `${name}.mjs`;
  const project = join(cwd, CONFIG_DIR_NAME, CHECKS_DIR_NAME, file);
  if (existsSync(project)) return project;
  const global = join(getAgentDir(), CHECKS_DIR_NAME, file);
  if (existsSync(global)) return global;
  return undefined;
}

function normalizeOutput(value: unknown): { verdict: CheckVerdict; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { verdict: "pass", message: "" };
  const record = value as Record<string, unknown>;
  const verdict = record.verdict === "warn" || record.verdict === "block" ? record.verdict : "pass";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  return { verdict, message };
}

function runFile(file: string, input: CheckInput): Promise<{ verdict: CheckVerdict; message: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, JSON.stringify(input)],
      { timeout: CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) return resolve({ verdict: "pass", message: "" });
        try {
          resolve(normalizeOutput(JSON.parse(String(stdout).trim())));
        } catch {
          resolve({ verdict: "pass", message: "" });
        }
      },
    );
  });
}

export async function runPreChecks(names: string[], input: CheckInput): Promise<CheckSummary> {
  const messages: string[] = [];
  let remaining = MAX_CHECK_TOTAL_CHARS;
  for (const name of names.slice(0, MAX_CHECKS)) {
    const file = resolveCheckFile(name, input.cwd);
    if (!file) continue;
    const result = await runFile(file, input);
    if (result.verdict === "block") {
      const text = truncate(result.message || `Check ${name} blocked this mutation.`);
      return { messages, blocked: `[check:${name}] ${text}`, triggered: true };
    }
    if (result.verdict === "warn" && result.message && remaining > 0) {
      const text = truncate(result.message);
      messages.push(`[check:${name}] ${text}`);
      remaining -= text.length;
    }
  }
  return { messages, triggered: messages.length > 0 };
}

export function extractStagedContent(tool: MutationTool, rawArgs: unknown): string | undefined {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;
  const args = rawArgs as Record<string, unknown>;
  if (tool === "write") {
    return typeof args.content === "string" && args.content.length > 0 ? args.content : undefined;
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) return undefined;
  const parts: string[] = [];
  for (const edit of args.edits) {
    if (!edit || typeof edit !== "object") continue;
    const record = edit as Record<string, unknown>;
    const nested = [record.insert_after, record.replace, record.replace_lines, record.set_line].filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object",
    );
    for (const item of nested) {
      for (const key of ["content", "new_text", "newText"]) {
        if (typeof item[key] === "string" && (item[key] as string).length > 0) {
          parts.push(item[key] as string);
          break;
        }
      }
    }
    for (const key of ["newText", "new_text", "content"]) {
      if (typeof record[key] === "string" && (record[key] as string).length > 0) {
        parts.push(record[key] as string);
        break;
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export async function readDiskContent(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

export async function buildCheckInput(
  tool: MutationTool,
  rawArgs: unknown,
  cwd: string,
  relativePath: string,
  absolutePath: string,
): Promise<CheckInput> {
  return {
    phase: "pre",
    tool,
    cwd,
    relativePath,
    absolutePath,
    stagedContent: extractStagedContent(tool, rawArgs),
    diskContent: await readDiskContent(absolutePath),
  };
}
