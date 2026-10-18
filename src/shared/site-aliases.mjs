// The same service under another name: Threads moved from threads.net to threads.com and still links
// and redirects between them, and doda keeps its account pages on app.doda.jp. A task that allowed one
// name was stopped as target_origin_not_allowed on the other (2026-10-18: 15 stops in three days,
// threads.net 10, app.doda.jp 5). An allowlist that names one member of a group allows the whole group.
const GROUPS = [
  ["https://www.threads.com", "https://threads.com", "https://www.threads.net", "https://threads.net"],
  ["https://doda.jp", "https://www.doda.jp", "https://app.doda.jp"],
];
const MAX_ORIGINS = 32;

export function withSiteAliases(origins) {
  const out = [...origins];
  for (const origin of origins) {
    let normalized;
    try { normalized = new URL(origin).origin; } catch { continue; }
    for (const group of GROUPS) {
      if (!group.includes(normalized)) continue;
      for (const alias of group) if (!out.includes(alias) && out.length < MAX_ORIGINS) out.push(alias);
    }
  }
  return out;
}
