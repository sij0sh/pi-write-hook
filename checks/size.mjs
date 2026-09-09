// Size check: warns when staged or disk content exceeds 500 non-blank lines.
// Skips markdown, minified bundles, and lockfiles. Never blocks.

const WARN_LOC = 500;

function baseName(path) {
  return String(path ?? "").replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function isSkipped(relativePath) {
  const base = baseName(relativePath);
  if (/\.(md|mdx|markdown)$/.test(base)) return true;
  if (/\.min\./.test(base)) return true;
  return /(^|[.\-_])lock([.\-_]|$)/.test(base);
}

function countLoc(text) {
  return String(text ?? "").split("\n").filter((line) => line.trim().length > 0).length;
}

export async function main(input) {
  const content = input.stagedContent ?? input.diskContent ?? null;
  if (content === null || isSkipped(input.relativePath)) return { verdict: "pass", message: "" };
  const loc = countLoc(content);
  if (loc < WARN_LOC) return { verdict: "pass", message: "" };
  return {
    verdict: "warn",
    message: `${input.relativePath} is ${loc} non-blank lines (target below ${WARN_LOC}). Split it into cohesive sibling modules.`,
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
