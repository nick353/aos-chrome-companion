/**
 * Resolve the origin of the exact frame that Chrome reported for a page
 * operation. Frame 0 is the top-level document; when Chrome temporarily
 * omits its URL, the live tab URL is the only safe fallback. We never use a
 * top-level URL as a fallback for a nested frame.
 */
function parseOrigin(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = new URL(String(value));
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizedAllowedOrigins(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(parseOrigin).filter(Boolean))];
}

export function resolveFrameOrigin({ frameId, result, tabUrl = null } = {}) {
  const normalizedFrameId = Number.isSafeInteger(frameId) ? frameId : 0;
  const directOrigin = parseOrigin(result?.url);
  if (directOrigin) {
    return { origin: directOrigin, source: "frame_url", needsTabUrl: false };
  }
  if (normalizedFrameId !== 0) {
    return { origin: null, source: null, needsTabUrl: false };
  }
  const topLevelOrigin = parseOrigin(result?.topLevelUrl);
  if (topLevelOrigin) {
    return { origin: topLevelOrigin, source: "top_level_url", needsTabUrl: false };
  }
  const liveTabOrigin = parseOrigin(tabUrl);
  return {
    origin: liveTabOrigin,
    source: liveTabOrigin ? "live_tab_url" : null,
    needsTabUrl: !liveTabOrigin,
  };
}

export function checkFrameOrigin({ frameId, result, tabUrl = null, allowedOrigins = [] } = {}) {
  const allowed = normalizedAllowedOrigins(allowedOrigins);
  const resolved = resolveFrameOrigin({ frameId, result, tabUrl });
  return {
    ...resolved,
    allowedOrigins: allowed,
    allowed: Boolean(resolved.origin && allowed.includes(resolved.origin)),
  };
}

