import { describe, it, expect } from 'vitest';
import { buildAudioTranscodeArgs, parseTranscodeLimit, parseUpstreamStatus, sanitizeDetail } from './transcode.ts';

describe('parseTranscodeLimit', () => {
  it('falls back to the default for missing or invalid input', () => {
    expect(parseTranscodeLimit(undefined)).toBe(4);
    expect(parseTranscodeLimit('')).toBe(4);
    expect(parseTranscodeLimit('   ')).toBe(4);
    expect(parseTranscodeLimit('nope')).toBe(4);
  });

  it('accepts a positive limit', () => {
    expect(parseTranscodeLimit('8')).toBe(8);
    expect(parseTranscodeLimit('1')).toBe(1);
  });

  it('treats zero and negatives as "disabled"', () => {
    expect(parseTranscodeLimit('0')).toBe(0);
    expect(parseTranscodeLimit('-2')).toBe(0);
  });
});

describe('parseUpstreamStatus', () => {
  it('reads the status ffmpeg reports verbatim', () => {
    expect(parseUpstreamStatus('http://127.0.0.1:3000/live/u/p/1: Server returned 404 Not Found')).toBe(404);
    expect(parseUpstreamStatus('Server returned 403 Forbidden (access denied)')).toBe(403);
    expect(parseUpstreamStatus('Server returned 429 Too Many Requests')).toBe(429);
  });

  it('maps ffmpeg\'s collapsed messages back to a status', () => {
    // 409 is the only 4xx our loopback returns that ffmpeg does not name.
    expect(parseUpstreamStatus('Server returned 4XX Client Error, but not one of 40{0,1,3,4}')).toBe(409);
    expect(parseUpstreamStatus('Server returned 5XX Server Error reply')).toBe(502);
  });

  it('returns null for non-HTTP failures', () => {
    expect(parseUpstreamStatus('Invalid data found when processing input')).toBeNull();
    expect(parseUpstreamStatus('')).toBeNull();
  });
});

describe('sanitizeDetail', () => {
  it('removes the loopback URL that carries playlist credentials', () => {
    const raw = 'Error opening input file http://127.0.0.1:3000/live/user/secret/123. Error opening input files: Server returned 404 Not Found';
    const clean = sanitizeDetail(raw);
    expect(clean).not.toContain('secret');
    expect(clean).not.toContain('127.0.0.1');
    expect(clean).toContain('Server returned 404 Not Found');
  });

  it('keeps the last two lines and caps the length', () => {
    const clean = sanitizeDetail(['noise 1', 'line 2', 'line 3'].join('\n'));
    expect(clean).toBe('line 2 line 3');
  });
});

describe('buildAudioTranscodeArgs', () => {
  const args = buildAudioTranscodeArgs('http://127.0.0.1:3000/live/u/p/123');
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1];

  it('copies the video bitstream instead of re-encoding it', () => {
    expect(valueOf('-c:v')).toBe('copy');
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-s');
  });

  it('re-encodes audio to stereo AAC', () => {
    expect(valueOf('-c:a')).toBe('aac');
    expect(valueOf('-ac')).toBe('2');
    expect(valueOf('-b:a')).toBe('160k');
  });

  it('keeps the MPEG-TS container so mpegts.js can play it unchanged', () => {
    expect(valueOf('-f')).toBe('mpegts');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  it('makes the stream maps optional so video- or audio-only channels do not abort', () => {
    expect(valueOf('-map')).toBe('0:v:0?');
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
  });

  it('passes the loopback URL as input and marks itself for the proxy', () => {
    expect(valueOf('-i')).toBe('http://127.0.0.1:3000/live/u/p/123');
    expect(valueOf('-headers')).toContain('x-gecko-transcode: 1');
    expect(args.indexOf('-i')).toBeGreaterThan(args.indexOf('-headers'));
  });

  it('caps probing so zapping does not wait for the default 5 s budget', () => {
    expect(Number(valueOf('-analyzeduration'))).toBeLessThanOrEqual(1_000_000);
    expect(args.indexOf('-analyzeduration')).toBeLessThan(args.indexOf('-i'));
  });
});
