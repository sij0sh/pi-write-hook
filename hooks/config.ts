// Two-layer hook config: global file, then project file with id-replace compose.
// Only rules that could produce output (instructions, context includes, or
// check scripts) count as effective for extension registration.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { hashText } from "./fingerprint.ts";

export const CONFIG_REL_PATH = "write-hook/edit-write.json";
export const LEGACY_CONFIG_REL_PATH = "hooks/edit-write.json";
export const CONFIG_ENV_OVERRIDE = "WRITE_HOOK_CONFIG";

export interface HookWhen {
  tool?: "edit" | "write";
  path?: string;
  glob?: string;
  ext?: string;
  basename?: string;
}

export interface HookContextInclude {
  path: string;
}

export interface HookExclude {
  tool?: "edit" | "write";
  path?: string;
  glob?: string;
  ext?: string;
  basename?: string;
}

export type HookTrigger = "match" | "check";

export interface HookRule {
  id: string;
  when: HookWhen;
  exclude?: HookExclude;
  instructions?: string[];
  context?: HookContextInclude[];
  checks?: string[];
  trigger?: HookTrigger;
}

export interface HookConfig {
  rules: HookRule[];
}

export interface LoadedConfig {
  config: HookConfig;
  warnings: string[];
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSelectors(raw: unknown): HookWhen {
  const out: HookWhen = {};
  if (!isRecord(raw)) return out;
  if (raw.tool === "edit" || raw.tool === "write") out.tool = raw.tool;
  if (typeof raw.path === "string" && raw.path.trim()) out.path = raw.path.trim();
  if (typeof raw.glob === "string" && raw.glob.trim()) out.glob = raw.glob.trim();
  if (typeof raw.ext === "string" && raw.ext.trim()) out.ext = raw.ext.trim();
  if (typeof raw.basename === "string" && raw.basename.trim()) {
    out.basename = raw.basename.trim();
  }
  return out;
}

function cleanCheckNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const base = item.trim().replace(/\.(mjs|js)$/i, "");
    if (!/^[A-Za-z0-9_-]+$/.test(base) || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

export function effectiveTrigger(rule: HookRule): HookTrigger {
  if (rule.trigger === "match" || rule.trigger === "check") return rule.trigger;
  return (rule.checks?.length ?? 0) > 0 ? "check" : "match";
}

function hasAnySelector(value: HookWhen | HookExclude): boolean {
  return Boolean(value.tool || value.path || value.glob || value.ext || value.basename);
}

function parseRule(raw: unknown): HookRule | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
  if (!isRecord(raw.when)) return undefined;
  const when = parseSelectors(raw.when);
  const exclude = isRecord(raw.exclude) ? parseSelectors(raw.exclude) : undefined;
  const instructions = cleanStrings(raw.instructions);
  const checks = cleanCheckNames(raw.checks);
  const rawTrigger = (raw as Record<string, unknown>).trigger;
  const trigger = rawTrigger === "match" || rawTrigger === "check" ? rawTrigger : undefined;
  const context: HookContextInclude[] = Array.isArray(raw.context)
    ? raw.context
        .filter(isRecord)
        .filter((item) => typeof item.path === "string" && item.path.trim().length > 0)
        .map((item) => ({ path: (item.path as string).trim() }))
    : [];
  return {
    id: raw.id.trim(),
    when,
    ...(exclude && hasAnySelector(exclude) ? { exclude } : {}),
    instructions: instructions.length > 0 ? instructions : undefined,
    context: context.length > 0 ? context : undefined,
    checks: checks.length > 0 ? checks : undefined,
    ...(trigger ? { trigger } : {}),
  };
}

export function parseConfig(raw: unknown): { config: HookConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { config: { rules: [] }, warnings };
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  const rules: HookRule[] = [];
  for (const item of list) {
    const rule = parseRule(item);
    if (!rule) {
      warnings.push("Dropped a hook rule without a usable id and when clause.");
      continue;
    }
    if (!rule.when.path && !rule.when.glob && !rule.when.ext && !rule.when.basename) {
      warnings.push(`Dropped hook rule "${rule.id}": no target selector.`);
      continue;
    }
    rules.push(rule);
    if (isRecord(item) && item.checks !== undefined && (rule.checks?.length ?? 0) === 0) {
      warnings.push(`Hook rule "${rule.id}" lists no usable checks.`);
    }
    for (const line of rule.instructions ?? []) {
      if (isFetchDirective(line)) {
        warnings.push(`Hook rule "${rule.id}" tells the model to fetch files; include the content instead.`);
        break;
      }
    }
  }
  return { config: { rules }, warnings };
}

function isFetchDirective(line: string): boolean {
  return /\b(read|open|load|cat|fetch|grep|see|check)\b[^.\n]{0,40}\b(file|files|path|contents|docs?|config)\b/i.test(line);
}

async function readConfigFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export function composeConfigs(globalConfig: HookConfig, projectConfig: HookConfig): HookConfig {
  const rules = [...globalConfig.rules];
  for (const rule of projectConfig.rules) {
    const index = rules.findIndex((item) => item.id === rule.id);
    if (index >= 0) rules[index] = rule;
    else rules.push(rule);
  }
  return { rules };
}

// A rule is potentially effective when it could produce model-facing output.
export function ruleHasPotential(rule: HookRule): boolean {
  return (
    (rule.instructions?.length ?? 0) > 0 ||
    (rule.context?.length ?? 0) > 0 ||
    (rule.checks?.length ?? 0) > 0
  );
}

export function hasEffectiveHooks(config: HookConfig): boolean {
  return config.rules.some(ruleHasPotential);
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const override = process.env[CONFIG_ENV_OVERRIDE]?.trim();
  if (override) {
    const raw = await readConfigFile(override);
    const parsed = parseConfig(raw ?? {});
    if (raw === undefined) {
      parsed.warnings.push(`WRITE_HOOK_CONFIG points at an unreadable file: ${override}. No hooks active.`);
    }
    return finish(parsed);
  }
  const global = await loadLayer(join(getAgentDir(), CONFIG_REL_PATH), join(getAgentDir(), LEGACY_CONFIG_REL_PATH));
  const project = await loadLayer(
    join(cwd, CONFIG_DIR_NAME, CONFIG_REL_PATH),
    join(cwd, CONFIG_DIR_NAME, LEGACY_CONFIG_REL_PATH),
  );
  return finish({
    config: composeConfigs(global.config, project.config),
    warnings: [...global.warnings, ...project.warnings],
  });
}

async function loadLayer(currentPath: string, legacyPath: string): Promise<{ config: HookConfig; warnings: string[] }> {
  const raw = await readConfigFile(currentPath);
  if (raw !== undefined) return parseConfig(raw);
  const legacyRaw = await readConfigFile(legacyPath);
  if (legacyRaw === undefined) return { config: { rules: [] }, warnings: [] };
  const parsed = parseConfig(legacyRaw);
  parsed.warnings.push(`Legacy config ${legacyPath} is deprecated; move it to ${currentPath} and remove any empty hooks/ directory.`);
  return parsed;
}

function finish(parsed: { config: HookConfig; warnings: string[] }): LoadedConfig {
  return {
    config: parsed.config,
    warnings: parsed.warnings,
    fingerprint: hashText(JSON.stringify(parsed.config)),
  };
}
