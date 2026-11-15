/**
 * A picture's scale in its box (madarch-64o5.96): the fit that shows it whole, one zoom step, and whether the box has
 * anything to pan. Pure functions, so the arithmetic the review found wrong — fit ignoring the box's height, a lower
 * clamp that enlarged a tiny fit, panning refused at or below 100 % — is held by tests of its own.
 */

/** A drawn size in pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The smallest scale a reader may zoom to. */
export const MIN_SCALE = 0.05;
/** The largest scale a reader may zoom to. */
export const MAX_SCALE = 4;

/** The scale that shows the picture whole in the box: it fits both the width and the height, and never enlarges. */
export function fitScale(picture: Size, box: Size): number {
  if (picture.width <= 0 || picture.height <= 0) return 1;
  const width = (box.width - 2) / picture.width;
  const height = (box.height - 2) / picture.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(1, Math.max(MIN_SCALE, Math.min(width, height)));
}

/**
 * One zoom step. The floor is the smallest scale, never a fixed percentage above a picture's own fit — a 3 000 px
 * picture fitted at 11 % must shrink below that when the reader presses minus, not jump to 20 %.
 */
export function zoomStep(scale: number, factor: number): number {
  const next = Math.round(scale * factor * 100) / 100;
  const held = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  // Zooming out never enlarges, whatever rounding did.
  return factor < 1 ? Math.min(scale, held) : held;
}

/** Whether the picture, at its scale, stands larger than its box: then a drag pans it, whatever the scale is. */
export function pans(picture: Size, scale: number, box: Size): boolean {
  return picture.width * scale > box.width + 1 || picture.height * scale > box.height + 1;
}
