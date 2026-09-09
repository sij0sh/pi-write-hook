// Small deterministic hashes for hook and context fingerprints.
// FNV-1a over UTF-8 bytes. Not cryptographic; only used for change detection.

export function hashText(input: string): string {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(input, "utf-8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintHook(instructions: string[]): string {
  return hashText(JSON.stringify(instructions));
}

export function fingerprintContext(files: Array<{ path: string; content: string }>): string {
  return hashText(JSON.stringify(files.map((f) => [f.path, f.content])));
}
