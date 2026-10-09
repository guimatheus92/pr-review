import { extractFrames } from '../frames.js';
import { probeDuration } from '../probe.js';

export interface VideoAnalysis {
  duration: number;
  frames: string[];
  warnings: string[];
}

export async function analyzeVideo(videoPath: string): Promise<VideoAnalysis> {
  const extraction = await extractFrames(videoPath, 8);
  const duration = await probeDuration(videoPath);
  return { duration, frames: extraction.frames, warnings: extraction.warnings };
}
