// Target matching: operation x exact path x glob x extension x basename.
// All specified selectors must match (AND). Paths resolve against the session cwd.

import { basename, extname, resolve } from "node:path";
import type { HookRule } from "./config.ts";

export type MutationTool = "edit" | "write";

export function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function resolveTarget(rawPath: string, cwd: string): { absolute: string; relative: string } {
  const cleaned = stripAtPrefix(rawPath.trim());
  const absolute = resolve(cwd, cleaned);
  const relative = absolute.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")
    ? absolute.slice(cwd.length + 1)
    : cleaned.replace(/^\.\//, "");
  return { absolute, relative };
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

// Minimal glob compiler: **, *, ?. All other RegExp characters are escaped.
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  const text = toPosix(glob.replace(/^\.\//, ""));
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "*") {
      if (text[i + 1] === "*") {
        if (text[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

function normalizeExt(ext: string): string {
  const cleaned = ext.trim().toLowerCase();
  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

export function matchRule(rule: HookRule, tool: MutationTool, relativePosix: string): boolean {
  const when = rule.when;
  if (when.tool && when.tool !== tool) return false;
  if (when.path && toPosix(when.path.replace(/^\.\//, "")) !== relativePosix) return false;
  if (when.glob && !globToRegExp(when.glob).test(relativePosix)) return false;
  if (when.ext && extname(relativePosix).toLowerCase() !== normalizeExt(when.ext)) return false;
  if (when.basename && basename(relativePosix) !== when.basename) return false;
  if (rule.exclude && matchesExclude(rule.exclude, tool, relativePosix)) return false;
  return true;
}

// A rule is excluded when every specified exclude selector matches (AND),
// mirroring the positive `when` semantics. An empty exclude never matches.
export function matchesExclude(
  exclude: NonNullable<HookRule["exclude"]>,
  tool: MutationTool,
  relativePosix: string,
): boolean {
  if (!exclude.tool && !exclude.path && !exclude.glob && !exclude.ext && !exclude.basename) {
    return false;
  }
  if (exclude.tool && exclude.tool !== tool) return false;
  if (exclude.path && toPosix(exclude.path.replace(/^\.\//, "")) !== relativePosix) return false;
  if (exclude.glob && !globToRegExp(exclude.glob).test(relativePosix)) return false;
  if (exclude.ext && extname(relativePosix).toLowerCase() !== normalizeExt(exclude.ext)) return false;
  if (exclude.basename && basename(relativePosix) !== exclude.basename) return false;
  return true;
}

export function matchHooks(
  rules: HookRule[],
  tool: MutationTool,
  relativePosix: string,
): HookRule[] {
  return rules.filter((rule) => matchRule(rule, tool, relativePosix));
}
