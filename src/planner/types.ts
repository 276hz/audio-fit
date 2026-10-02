export type Fmt = 'flac' | 'wav' | 'aiff' | 'alac' | 'mp3' | 'aac' | 'opus' | 'vorbis';
export const LOSSLESS: readonly Fmt[] = ['flac', 'wav', 'aiff', 'alac'];

export interface AudioInfo {
  durationSec: number;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  sizeBytes: number;
  format: Fmt;
  /** Best estimate of this audio re-encoded as FLAC -8 (bytes). For FLAC input: current size. */
  flacBytesEstimate: number;
}

export interface Constraints {
  maxBytes: number;
  allowedFormats: Fmt[];
  minSampleRate: number;
  minBitDepth: number;
  allowSplit: boolean;
  allowLossy: boolean;
}

export interface SilenceCandidate {
  startSample: number; // inclusive
  endSample: number; // exclusive
  depthDb: number; // more negative = deeper
}

export interface PlanOption {
  id: string;
  kind: 'lossless-single' | 'lossless-split' | 'lossy';
  format: Fmt;
  bitrateKbps?: number;
  parts: number;
  /** sample-accurate cut points (frame indices), length = parts-1 */
  splitSamples: number[];
  partBytes: number[];
  totalBytes: number;
  lossless: boolean;
  validForTarget: boolean;
  /** i18n keys, not prose; the UI translates them */
  reasons: string[];
}

export interface PlanResult {
  singleLosslessPossible: boolean;
  inputBelowMinimum: boolean;
  losslessSingleBytes: number;
  options: PlanOption[];
}
