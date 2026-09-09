// ASCII check: blocks non-ASCII write content and edit replacements.
// Honors the legacy .ascii-only marker during migration: without the marker
// the check passes, so rule scope alone can take over later.

import { existsSync } from "node:fs";
import { join } from "node:path";

const NON_ASCII = /[^\x00-\x7F]/;

function label(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function firstViolation(text) {
  if (typeof text !== "string") return undefined;
  const offset = text.search(NON_ASCII);
  if (offset < 0) return undefined;
  const codePoint = text.codePointAt(offset) ?? text.charCodeAt(offset);
  return { offset, codePoint };
}

export async function main(input) {
  if (!existsSync(join(input.cwd, ".ascii-only"))) return { verdict: "pass", message: "" };
  const violation = firstViolation(input.stagedContent);
  if (!violation) return { verdict: "pass", message: "" };
  return {
    verdict: "block",
    message: `Non-ASCII content at offset ${violation.offset + 1} (${label(violation.codePoint)}). Use ASCII.`,
  };
}

const raw = process.argv[2];
try {
  const input = JSON.parse(raw ?? "{}");
  main(input).then(
    (result) => console.log(JSON.stringify(result)),
    () => console.log(JSON.stringify({ verdict: "pass", message: "" })),
  );
} catch {
  console.log(JSON.stringify({ verdict: "pass", message: "" }));
}
