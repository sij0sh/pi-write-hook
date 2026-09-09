// Style check: warns on strong writing-style signals in markdown.
// Masks frontmatter, fences, blockquotes, tables, code spans, and URLs, then
// reports long sentences, trailing conditions, and prose enumerations.
// Never blocks.

const LONG_WORDS = 50;
const MAX_SIGNALS = 5;
const ENUM_RE = /^(first|second|third|next|then|finally|lastly)(?=[\s,:;])/i;
const TRAILING_RE = /,\s*(if|when|unless)\s+[^,.!?]*[.!?]?\s*$/i;

const RULES = [
  "State one rule or action per sentence.",
  "Use short, direct, active-voice sentences with explicit subjects.",
  "When a rule depends on a condition, state the condition before the required action.",
  "Use lists for procedures, tables for decisions, and schemas for structured inputs or outputs.",
  "Use one term for each concept.",
  "Use ASCII unless Unicode is required.",
];

function isMarkdown(path) {
  return /\.(md|markdown)$/i.test(String(path ?? ""));
}

function mask(text) {
  const lines = String(text ?? "").split("\n");
  let start = 0;
  if (lines[0]?.trimEnd() === "---") {
    let end = 1;
    while (end < lines.length && lines[end].trimEnd() !== "---") end++;
    if (end < lines.length) {
      for (let i = 0; i <= end; i++) lines[i] = "";
      start = end + 1;
    }
  }
  let fence = false;
  for (let i = start; i < lines.length; i++) {
    if (/^\s{0,3}>\s?/.test(lines[i])) {
      lines[i] = "";
      continue;
    }
    // Table rows carry no sentence boundaries; scanned as one line they read
    // as one giant sentence, so they are excluded like fences.
    if (/^\s{0,3}\|/.test(lines[i])) {
      lines[i] = "";
      continue;
    }
    const isFence = /^\s{0,3}(```|~~~)/.test(lines[i]);
    if (fence) {
      lines[i] = "";
      if (isFence) fence = false;
    } else if (isFence) {
      lines[i] = "";
      fence = true;
    }
  }
  return lines
    .map((line) =>
      line
        .replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length))
        .replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length)),
    )
    .join("\n");
}

function sentences(text) {
  const out = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]*/g)) {
    if (m[0].trim()) out.push({ text: m[0], offset: m.index ?? 0 });
  }
  return out;
}

export async function main(input) {
  if (!isMarkdown(input.relativePath)) return { verdict: "pass", message: "" };
  const content = input.stagedContent ?? input.diskContent ?? null;
  if (!content || !content.trim()) return { verdict: "pass", message: "" };
  const masked = mask(content);
  const signals = [];
  const paragraphs = masked.split(/\n\s*\n/);
  let lineBase = 1;
  for (const para of paragraphs) {
    const lines = para.split("\n");
    const markers = new Set();
    for (const s of sentences(para)) {
      const words = s.text.match(/\S+/g)?.length ?? 0;
      if (words > LONG_WORDS) signals.push(`long sentence (${words} words); consider splitting`);
      const trailing = TRAILING_RE.exec(s.text);
      if (trailing) signals.push(`trailing "${trailing[1].toLowerCase()}" condition; state it first`);
      const marker = ENUM_RE.exec(s.text.trimStart());
      if (marker) markers.add(marker[1].toLowerCase());
    }
    if (markers.size >= 3) signals.push("enumerated steps in prose; use a list");
    lineBase += lines.length;
    if (signals.length >= MAX_SIGNALS) break;
  }
  if (signals.length === 0) return { verdict: "pass", message: "" };
  const shown = signals.slice(0, MAX_SIGNALS).map((s) => `- ${s}`).join("\n");
  return {
    verdict: "warn",
    message: `Style check found ${signals.length} signal${signals.length === 1 ? "" : "s"}:\n${shown}\nRules:\n${RULES.map((r) => `- ${r}`).join("\n")}`,
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
