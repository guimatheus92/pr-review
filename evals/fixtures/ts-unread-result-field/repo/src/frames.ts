import { runFfmpeg } from './ffmpeg.js';

export interface FrameExtraction {
  frames: string[];
  warnings: string[];
}

/** Extracts `count` evenly spaced key frames from a video file. */
export async function extractFrames(videoPath: string, count: number): Promise<FrameExtraction> {
  const result = await runFfmpeg(videoPath, count);
  return { frames: result.frames, warnings: result.warnings };
}
