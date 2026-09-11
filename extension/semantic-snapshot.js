function normalized(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function mergeSemanticSnapshotResults(results, maxTextChars = 30_000) {
  const frames = (Array.isArray(results) ? results : [])
    .filter((entry) => entry?.result && typeof entry.result === "object")
    .sort((left, right) => (left.frameId === 0 ? -1 : right.frameId === 0 ? 1 : left.frameId - right.frameId));
  if (frames.length === 0) return null;
  const main = frames.find((entry) => entry.frameId === 0) ?? frames[0];
  const textSegments = [];
  const seenText = new Set();
  const controls = [];
  for (const frame of frames) {
    const text = normalized(frame.result.text);
    if (text && !seenText.has(text)) {
      seenText.add(text);
      textSegments.push(text);
    }
    for (const control of Array.isArray(frame.result.controls) ? frame.result.controls : []) {
      if (controls.length >= 300) break;
      controls.push({ ...control, frameId: frame.frameId });
    }
  }
  const text = textSegments.join(" ").slice(0, maxTextChars);
  const readyState = frames.every((entry) => entry.result.readyState === "complete") ? "complete" : main.result.readyState;
  return {
    url: main.result.url,
    topLevelUrl: main.result.topLevelUrl ?? main.result.url ?? null,
    title: main.result.title,
    readyState,
    pageInstanceId: main.result.pageInstanceId ?? null,
    text,
    controls,
    frameCount: frames.length,
    semanticEmpty: text.length === 0 && controls.length === 0,
    frames: frames.map((entry) => ({
      frameId: entry.frameId,
      url: entry.result.url,
      topLevelUrl: entry.result.topLevelUrl ?? entry.result.url ?? null,
      title: entry.result.title,
      readyState: entry.result.readyState,
      pageInstanceId: entry.result.pageInstanceId ?? null,
      framePath: Array.isArray(entry.result.framePath) ? entry.result.framePath : [],
      coordinateSpace: entry.result.coordinateSpace ?? "viewport",
      textChars: normalized(entry.result.text).length,
      controlCount: Array.isArray(entry.result.controls) ? entry.result.controls.length : 0,
    })),
  };
}
