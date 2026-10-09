import { extractFrames } from '../frames.js';

export interface VideoAnalysis {
  duration: number;
  frames: string[];
  warnings: string[];
}

export async function analyzeVideo(videoPath: string): Promise<VideoAnalysis> {
  const extraction = await extractFrames(videoPath, 8);
  return { duration: extraction.duration, frames: extraction.frames, warnings: extraction.warnings };
}
