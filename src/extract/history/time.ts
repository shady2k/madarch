/**
 * The two instants the history extractor writes: git's own epoch seconds
 * (committer and author times) and decision 0028's effective time, which a
 * bumped commit carries as whole microseconds.
 */

/** Whole seconds since the epoch as ISO 8601 with `Z`, the way git dates read: `2026-08-04T10:00:00Z`. */
export function isoSeconds(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`the history extractor reads the epoch seconds ${epochSeconds}, which is no instant an ISO 8601 time holds`);
  }
  return at.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * Microseconds since the epoch: a raw committer time carries no fraction, and
 * the smallest bump decision 0028 allows (`parent effective + 1 microsecond`)
 * prints its six digits, so the string order of two effective times of one
 * first-parent line is their time order.
 */
export function isoMicros(micros: number): string {
  if (!Number.isSafeInteger(micros)) {
    throw new Error(`the history extractor computes the instant ${micros} microseconds, which is no whole instant`);
  }
  const seconds = Math.floor(micros / 1_000_000);
  const fraction = micros - seconds * 1_000_000;
  if (fraction === 0) return isoSeconds(seconds);
  return `${isoSeconds(seconds).slice(0, -1)}.${String(fraction).padStart(6, '0')}Z`;
}
