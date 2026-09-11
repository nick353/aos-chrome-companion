import { createHmac } from 'node:crypto';
import { CompanionError } from './errors.mjs';

/** A bounded lossless patch at a canvas point; no canvas script or pixel API. */
export async function readCanvasVisualPatch({ inspection, capture, secret }) {
  if (inspection?.surfaceKind !== 'canvas') return null;
  const { point, viewport, scroll, surfaceRect } = inspection;
  const values = [point?.x, point?.y, viewport?.width, viewport?.height, scroll?.x, scroll?.y,
    surfaceRect?.x, surfaceRect?.y, surfaceRect?.width, surfaceRect?.height];
  if (values.some(value => !Number.isFinite(value))) throw new CompanionError('visual_canvas_geometry_unavailable', 'Read the canvas point again before input');
  const left = Math.max(0, surfaceRect.x, point.x - 32), top = Math.max(0, surfaceRect.y, point.y - 32);
  const right = Math.min(viewport.width, surfaceRect.x + surfaceRect.width, point.x + 32);
  const bottom = Math.min(viewport.height, surfaceRect.y + surfaceRect.height, point.y + 32);
  const clip = { x: left + scroll.x, y: top + scroll.y, width: right - left, height: bottom - top };
  if (clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0) throw new CompanionError('visual_canvas_geometry_unavailable', 'The canvas point is outside the visible capture region');
  const image = await capture({ format: 'png', clip });
  if (image?.mimeType !== 'image/png' || !image.dataBase64 || image.url !== inspection.url) {
    throw new CompanionError('visual_canvas_readback_mismatch', 'Canvas pixels and geometry did not identify the same document');
  }
  return { schema: 'aos.chrome_companion.canvas_visual_patch.v1', clip,
    imageDigest: createHmac('sha256', secret).update('canvas-visual-patch-v1\0').update(image.dataBase64).digest('hex') };
}

export function assertCanvasVisualPatchUnchanged(expected, current) {
  if ((expected == null) !== (current == null) || (expected &&
    (expected.schema !== current.schema || JSON.stringify(expected.clip) !== JSON.stringify(current.clip) || expected.imageDigest !== current.imageDigest))) {
    throw new CompanionError('visual_canvas_content_changed', 'The canvas pixels at the approved point changed; inspect the new image and obtain a fresh point proof',
      { operationEffectState: 'none', mutationDispatchAttempted: false });
  }
}
