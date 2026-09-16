import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/run.js';

export async function probe(file: string) {
  const { stdout, code } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${file}`);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
  };
  const s = j.streams?.[0] ?? {};
  const [num, den] = (s.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(j.format?.duration ?? 0),
    width: s.width ?? 0,
    height: s.height ?? 0,
    fps: den ? (num ?? 0) / den : 0,
  };
}

/**
 * The video half of normalize(): re-encode to a 720p-capped working copy.
 * Split out (spec §8 / Fix 2) so a caller that does not need the vision
 * path -- 'even'/'none' frame modes, which sample/skip the un-normalized
 * media directly -- never pays for this libx264 pass at all.
 */
export async function normalizeVideo(input: string, workDir: string) {
  const video = join(workDir, 'work.mp4');
  const v = await run('ffmpeg', [
    '-y', '-i', input,
    // force_divisible_by=2: aspect-preserving downscale of a portrait input
    // (1080x1920 -> 405x720) otherwise yields an ODD width, which libx264 +
    // yuv420p rejects outright ("Invalid argument") -- a guaranteed
    // first-contact failure on TikTok/Reels/Shorts-shaped sources.
    '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', video,
  ]);
  if (v.code !== 0) throw new Error(`normalize(video) failed: ${v.stderr.slice(-400)}`);
  return { video };
}

/**
 * The audio half of normalize(): extract a 16kHz mono wav. Split out (spec §8
 * / Fix 2) so a caller with transcript:false never pays for this pass.
 * If input has no audio stream, the audio file will not be created --
 * downstream treats file absence as "no audio" and decides whether to
 * transcribe accordingly.
 */
export async function extractAudio(input: string, workDir: string) {
  const audio = join(workDir, 'work.wav');
  await run('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
  return { audio };
}

/**
 * 720p working video + 16 kHz mono wav. Platform differences end here
 * (spec §8). Kept as a single call for existing/future callers that
 * genuinely want both; analyze.ts itself now calls normalizeVideo()/
 * extractAudio() independently so it only pays for what a given request
 * actually needs (Fix 2).
 */
export async function normalize(input: string, workDir: string) {
  const { video } = await normalizeVideo(input, workDir);
  const { audio } = await extractAudio(input, workDir);
  return { video, audio };
}

export async function trim(input: string, start: number, end: number, out: string) {
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out,
  ]);
  if (r.code !== 0) throw new Error(`trim failed: ${r.stderr.slice(-400)}`);
  return out;
}

export async function extractFrame(video: string, timestamp: number, out: string) {
  // Removed first so a file from an earlier call cannot pass for this one's.
  rmSync(out, { force: true });
  const r = await run('ffmpeg', ['-y', '-ss', String(timestamp), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
  if (r.code !== 0) throw new Error(`extractFrame failed at ${timestamp}: ${r.stderr.slice(-400)}`);
  // The exit code alone is not enough: Ubuntu 24.04's ffmpeg 6.1 exits 0 when
  // the seek lands past the last frame and simply writes nothing ("Output file
  // is empty, nothing was encoded"), where 8.x fails. Callers treat a returned
  // path as a real frame (getFrame's end-of-file retry, extractCandidates'
  // skip), so a missing file has to be a failure here.
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error(`extractFrame produced no frame at ${timestamp}: ${r.stderr.slice(-400)}`);
  }
  return out;
}

/**
 * Synthetic fixture: 1280x800 video with three colour segments (red->blue->green)
 * at hard cuts + silent audio track. Segment length defaults to 1/3 of `seconds`.
 *
 * Each segment carries a thin drawgrid overlay on top of its flat colour --
 * NOT decorative. A perfectly flat colour frame has zero-everywhere Laplacian
 * response (no edges anywhere), so src/vision/quality.ts's blur gate
 * (variance below BLUR_FLOOR=8 reads as blur/fade/dissolve) rejects every
 * single frame extracted from a flat-colour video, all the way down to 0
 * survivors -- verified directly: extractCandidates+filterCandidates on the
 * original flat-colour fixture returned 0/4 candidates for a 9s video, which
 * makes "a successful run produces a manifest with frames" (Task 14)
 * unsatisfiable no matter what the orchestrator does downstream. The grid
 * lines give every frame genuine edge content (confirmed: 4/4 candidates
 * survive with real quality scores) while staying cheap to encode (a
 * repeating line pattern is still highly compressible, ~100KB for 9s,
 * vs. tens of MB for full random noise) and leaving scene-cut timing/scoring
 * intact (boundaries still land within ~0.35s of each hard cut; verified
 * scdet scores ~0.197 at 9s and 6s, both comfortably clear of the detection
 * threshold and comfortably under the "suppress at threshold=50" test).
 */
export async function makeTestVideo(out: string, seconds = 6) {
  const per = Math.max(1, Math.floor(seconds / 3));
  const r = await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=1280x800:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=blue:s=1280x800:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=green:s=1280x800:d=${per}`,
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${per * 3}`,
    '-filter_complex',
    '[0:v]drawgrid=w=40:h=40:t=3:c=black@0.6[v0];' +
    '[1:v]drawgrid=w=40:h=40:t=3:c=white@0.6[v1];' +
    '[2:v]drawgrid=w=40:h=40:t=3:c=black@0.6[v2];' +
    '[v0][v1][v2]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-r', '25', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', out,
  ]);
  if (r.code !== 0) throw new Error(`makeTestVideo failed: ${r.stderr.slice(-400)}`);
  return out;
}
