import { describe, it, expect } from 'vitest';
import {
  detectPlaybackCapabilities,
  summarizeCapabilities,
  withAudioTranscodeParam,
} from './playback-capabilities.ts';

/** A MediaSource double that supports exactly the given types. */
function fakeMediaSource(types: string[]) {
  return { isTypeSupported: (type: string) => types.includes(type) };
}

const CHROMIUM_LIKE = fakeMediaSource([
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="av01.0.05M.08"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="opus"',
]);

const SAFARI_LIKE = fakeMediaSource([
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
]);

describe('detectPlaybackCapabilities', () => {
  it('reports the MSE allowlist for a Chromium-like browser', () => {
    const caps = detectPlaybackCapabilities({ MediaSource: CHROMIUM_LIKE });

    expect(caps.probed).toBe(true);
    expect(caps.mse).toBe(true);
    expect(caps.video.h264).toBe(true);
    expect(caps.video.av1).toBe(true);
    expect(caps.video.hevc).toBe(false);
    expect(caps.audio.aac).toBe(true);
    expect(caps.audio.ac3).toBe(false);
    expect(caps.audio.eac3).toBe(false);
    expect(caps.needsAudioTranscode).toBe(true);
  });

  it('does not flag transcoding when the browser decodes surround audio (Safari)', () => {
    const caps = detectPlaybackCapabilities({
      MediaSource: SAFARI_LIKE,
      videoElement: { canPlayType: () => 'probably' },
    });

    expect(caps.video.hevc).toBe(true);
    expect(caps.audio.ac3).toBe(true);
    expect(caps.audio.eac3).toBe(true);
    expect(caps.needsAudioTranscode).toBe(false);
    expect(caps.nativeHls).toBe(true);
  });

  it('falls back to the bare container type when a profile string is unknown', () => {
    // Some builds answer false for an unfamiliar profile but can still play the codec.
    const caps = detectPlaybackCapabilities({
      MediaSource: { isTypeSupported: (type: string) => type === 'video/mp4' },
    });
    expect(caps.video.h264).toBe(true);
    expect(caps.video.mpeg2).toBe(true);
  });

  it('degrades safely outside a browser', () => {
    const caps = detectPlaybackCapabilities({});
    expect(caps.probed).toBe(false);
    expect(caps.mse).toBe(false);
    expect(caps.mpegtsJs).toBe(false);
    expect(caps.needsAudioTranscode).toBe(true);
  });

  it('never throws when a probe implementation throws', () => {
    const caps = detectPlaybackCapabilities({
      MediaSource: { isTypeSupported: () => { throw new Error('boom'); } },
    });
    expect(caps.video.h264).toBe(false);
  });
});

describe('summarizeCapabilities', () => {
  it('lists only the supported codec labels', () => {
    const caps = detectPlaybackCapabilities({ MediaSource: CHROMIUM_LIKE });
    const summary = summarizeCapabilities(caps);

    expect(summary.video).toContain('H.264');
    expect(summary.video).not.toContain('H.265');
    expect(summary.audio).toEqual(['AAC', 'Opus']);
  });
});

describe('withAudioTranscodeParam', () => {
  const origin = 'https://gecko.example:3000';

  it('adds the flag to a proxied live URL', () => {
    const url = withAudioTranscodeParam('https://gecko.example:3000/live/u/p/123.ts', origin);
    expect(url).toBe('https://gecko.example:3000/live/u/p/123.ts?transcode=audio');
  });

  it('keeps an existing query string intact', () => {
    const url = withAudioTranscodeParam('https://gecko.example:3000/live/u/p/123.ts?x=1', origin);
    expect(url).toBe('https://gecko.example:3000/live/u/p/123.ts?x=1&transcode=audio');
  });

  it('returns null for a direct upstream URL (cannot be transcoded)', () => {
    expect(withAudioTranscodeParam('http://provider.example:8080/live/u/p/123.ts', origin)).toBeNull();
  });

  it('returns null without a known origin', () => {
    expect(withAudioTranscodeParam('/live/u/p/123.ts', undefined)).toBeNull();
  });
});
