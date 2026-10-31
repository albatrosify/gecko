/**
 * What the *browser* can actually play — measured on the path this app uses.
 *
 * GECKO's web player feeds MediaSource through mpegts.js (live TS) or hls.js
 * (m3u8). Everything therefore depends on the MSE allowlist, not on what the
 * JS library supports on paper: mpegts.js happily demuxes AC-3 and emits the
 * matching MP4 sample entry, but `addSourceBuffer` rejects it in every Chromium
 * and Firefox build. This module makes that gap visible instead of letting the
 * player fail with a generic "media error".
 */

export type VideoCodecId = 'h264' | 'hevc' | 'av1' | 'mpeg2' | 'mpeg4part2';
export type AudioCodecId = 'aac' | 'mp3' | 'opus' | 'ac3' | 'eac3' | 'dts' | 'mp2';

export interface PlaybackCapabilities {
  /** False when running outside a browser (SSR/tests) or without MSE. */
  probed: boolean;
  mse: boolean;
  /** mpegts.js can attach at all (needs MSE). */
  mpegtsJs: boolean;
  hlsJs: boolean;
  /** Safari/Apple: plays HLS natively, including AC-3 in an HLS manifest. */
  nativeHls: boolean;
  video: Record<VideoCodecId, boolean>;
  audio: Record<AudioCodecId, boolean>;
  /**
   * True when no surround audio codec used by IPTV can be decoded, i.e. the
   * channel probably needs the server-side AAC transcode.
   */
  needsAudioTranscode: boolean;
}

/** Minimal surface we probe, injectable so this stays testable under Node. */
export interface CapabilitySources {
  MediaSource?: { isTypeSupported(type: string): boolean } | null;
  videoElement?: { canPlayType(type: string): string } | null;
  mpegtsSupported?: boolean;
  hlsSupported?: boolean;
}

/** MSE type strings used for probing. Kept explicit: codec support is per-profile. */
export const PROBE_TYPES = {
  video: {
    h264: 'video/mp4; codecs="avc1.42E01E"',
    hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    av1: 'video/mp4; codecs="av01.0.05M.08"',
    mpeg2: 'video/mp4; codecs="mp2v"',
    mpeg4part2: 'video/mp4; codecs="mp4v.20.9"',
  },
  audio: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mp4; codecs="mp4a.40.34"',
    opus: 'audio/mp4; codecs="opus"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    dts: 'audio/mp4; codecs="dtsc"',
    mp2: 'audio/mp4; codecs="mp4a.69"',
  },
} as const satisfies {
  video: Record<VideoCodecId, string>;
  audio: Record<AudioCodecId, string>;
};

export const VIDEO_CODEC_LABELS: Record<VideoCodecId, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
  mpeg2: 'MPEG-2',
  mpeg4part2: 'MPEG-4',
};

export const AUDIO_CODEC_LABELS: Record<AudioCodecId, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  mp2: 'MP2',
};

/**
 * Splits an MSE type string into the generic capability question: some
 * browsers answer `false` for an unknown profile string while still being able
 * to decode the family, so a failed profile probe also falls back to the bare
 * container check.
 */
function probeType(mediaSource: CapabilitySources['MediaSource'], type: string): boolean {
  if (!mediaSource) return false;
  try {
    if (mediaSource.isTypeSupported(type)) return true;
    return mediaSource.isTypeSupported(type.split(';')[0]);
  } catch {
    return false;
  }
}

export function detectPlaybackCapabilities(sources: CapabilitySources = {}): PlaybackCapabilities {
  const mediaSource = sources.MediaSource ?? null;
  const videoElement = sources.videoElement ?? null;
  const mse = Boolean(mediaSource);

  const video = {} as Record<VideoCodecId, boolean>;
  for (const [id, type] of Object.entries(PROBE_TYPES.video) as [VideoCodecId, string][]) {
    video[id] = probeType(mediaSource, type);
  }

  const audio = {} as Record<AudioCodecId, boolean>;
  for (const [id, type] of Object.entries(PROBE_TYPES.audio) as [AudioCodecId, string][]) {
    audio[id] = probeType(mediaSource, type);
  }

  // AC-3/E-AC-3/DTS: no Chromium or Firefox build decodes them in MSE. MP2 only
  // works through the MP3 family and is unreliable, so it does not count as
  // "playable" on its own.
  const needsAudioTranscode = !audio.ac3 && !audio.eac3 && !audio.dts;

  return {
    probed: mse || Boolean(videoElement),
    mse,
    mpegtsJs: Boolean(sources.mpegtsSupported ?? mse),
    hlsJs: Boolean(sources.hlsSupported ?? mse),
    nativeHls: Boolean(videoElement?.canPlayType('application/vnd.apple.mpegurl')),
    video,
    audio,
    needsAudioTranscode,
  };
}

/** Reads the real browser globals; separate so tests can stay hermetic. */
export function browserCapabilitySources(mpegtsSupported?: boolean, hlsSupported?: boolean): CapabilitySources {
  if (typeof window === 'undefined') return {};
  const MediaSourceImpl = (window as any).MediaSource ?? (window as any).ManagedMediaSource ?? null;
  const probeVideo = document.createElement('video');
  return {
    MediaSource: MediaSourceImpl,
    videoElement: probeVideo,
    mpegtsSupported,
    hlsSupported,
  };
}

/** Human-readable list of what this browser can decode, e.g. `H.264, AV1 / AAC, Opus`. */
export function summarizeCapabilities(caps: PlaybackCapabilities): { video: string[]; audio: string[] } {
  const video = (Object.keys(caps.video) as VideoCodecId[])
    .filter((id) => caps.video[id])
    .map((id) => VIDEO_CODEC_LABELS[id]);
  const audio = (Object.keys(caps.audio) as AudioCodecId[])
    .filter((id) => caps.audio[id])
    .map((id) => AUDIO_CODEC_LABELS[id]);
  return { video, audio };
}

/**
 * Appends the transcode flag to a proxied live URL. Returns `null` for URLs we
 * cannot transcode (a direct upstream URL in `directStreams` mode) so the UI can
 * explain the limitation instead of retrying something that cannot work.
 */
export function withAudioTranscodeParam(url: string, origin?: string): string | null {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  if (!base) return null;

  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }

  // Only our own proxy can transcode; a direct provider URL cannot be routed
  // through the server without turning this into an open proxy.
  if (parsed.origin !== new URL(base).origin) return null;

  parsed.searchParams.set('transcode', 'audio');
  return url.startsWith('http') ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}
