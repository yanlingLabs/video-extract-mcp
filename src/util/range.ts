/**
 * Why a requested range cannot be served because it starts at or past the end
 * of the video, or null when it can. One sentence the agent can pass on as-is.
 *
 * Without this check such a request reached ffmpeg and failed as "the platform
 * refused that fetch" (23-60 s of a 19 s video, in the first live run of the
 * acceptance matrix): a wrong diagnosis that sends the caller off retrying.
 */
export function rangePastEnd(start: number | undefined, duration: number | null | undefined): string | null {
  if (start === undefined || typeof duration !== 'number' || !(duration > 0) || start < duration) return null;
  const secs = Math.round(duration * 10) / 10;
  return `The requested range starts at ${start}s, but the video is only ${secs}s long. `
    + `Ask for a range inside 0-${secs}s, or leave start and end out for the whole video.`;
}
