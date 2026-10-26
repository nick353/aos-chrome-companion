// The same service under another name: Threads moved from threads.net to threads.com and still links
// and redirects between them, and doda keeps its account pages on app.doda.jp. A task that allowed one
// name was stopped as target_origin_not_allowed on the other (2026-10-18: 15 stops in three days,
// threads.net 10, app.doda.jp 5). An allowlist that names one member of a group allows the whole group.
const GROUPS = [
  ["https://www.threads.com", "https://threads.com", "https://www.threads.net", "https://threads.net"],
  ["https://doda.jp", "https://www.doda.jp", "https://app.doda.jp"],
  // Greenhouse moved its hosted job boards: boards.greenhouse.io answers 301 to job-boards.greenhouse.io
  // (2026-10-18, a Datadog application stopped as target_origin_mismatch).
  ["https://boards.greenhouse.io", "https://job-boards.greenhouse.io"],
  // 2026-10-26 オーナー承認（AOS docs/companion-origin-table-2026-10-26.md の2〜8）。同じ会社・同じサービスの別ドメインだけ。
  // Google・Slack のワークスペース・Workday の会社ごとの区画・別の会社のサイトは入れない（手順書で宣言する）。
  ["https://access.line.me", "https://chat.line.me", "https://line.me", "https://web.line.me", "https://chat.line.biz", "https://manager.line.biz", "https://account.line.biz"],
  ["https://career.levtech.jp", "https://auth.levtech.jp", "https://mypage.levtech.jp"],
  ["https://next.rikunabi.com", "https://rikunabi-next.yahoo.co.jp"],
  ["https://www.linkedin.com", "https://linkedin.com", "https://jp.linkedin.com", "https://lnkd.in"],
  ["https://www.facebook.com", "https://facebook.com", "https://business.facebook.com"],
  ["https://www.hays.co.jp", "https://m.hays.co.jp"],
  ["https://www.turing.com", "https://work.turing.com"],
  ["https://tiktok.com", "https://www.tiktok.com"],
  ["https://careerengine.jp", "https://www.careerengine.jp"],
];
export const SITE_ALIAS_GROUPS = GROUPS;
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
