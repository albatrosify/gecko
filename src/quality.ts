import { DetectedStreamMeta, StreamMapping } from './types';

// ── Resolution → human label ──────────────────────────────────────────────────

export function resolutionToLabel(resolution: string): string {
  const match = resolution.match(/\d+x(\d+)/i);
  if (!match) return '';
  const h = parseInt(match[1], 10);
  if (h <= 480) return 'SD';
  if (h <= 720) return 'HD';
  if (h <= 1080) return 'FHD';
  if (h <= 1440) return 'QHD';
  if (h <= 2160) return 'UHD';
  return '8K';
}

// ── Codec display labels ───────────────────────────────────────────────────────

const VIDEO_CODEC_LABELS: Record<string, string> = {
  hevc: 'H.265', h265: 'H.265', h264: 'H.264', avc: 'H.264', av1: 'AV1', vp9: 'VP9',
};

const AUDIO_CODEC_LABELS: Record<string, string> = {
  eac3: 'DD+', ac3: 'DD', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', mp3: 'MP3', opus: 'Opus',
};

const CHANNEL_COUNT_LABELS: Record<number, string> = {
  1: 'Mono', 2: '2.0', 6: '5.1', 8: '7.1',
};

// ── Template rendering ─────────────────────────────────────────────────────────

/**
 * Replace template variables with values from detected metadata.
 * Unknown/empty variables render as empty string.
 * Empty bracket pairs like "[]" or "()" are removed automatically.
 *
 * Available variables: {label} {res} {codec} {hdr} {audio} {fps}
 */
export function renderTemplate(format: string, meta: DetectedStreamMeta): string {
  const label = meta.resolution ? resolutionToLabel(meta.resolution) : '';
  const codec = meta.videoCodec
    ? (VIDEO_CODEC_LABELS[meta.videoCodec.toLowerCase()] ?? meta.videoCodec.toUpperCase())
    : '';
  const hdr = meta.hdr ?? '';
  const fps = meta.fps != null ? String(meta.fps) : '';

  const audioCodecLabel = meta.audioCodec
    ? (AUDIO_CODEC_LABELS[meta.audioCodec.toLowerCase()] ?? meta.audioCodec.toUpperCase())
    : '';
  const channelLabel = meta.audioChannels != null
    ? (CHANNEL_COUNT_LABELS[meta.audioChannels] ?? String(meta.audioChannels))
    : '';
  const audio = [audioCodecLabel, channelLabel].filter(Boolean).join(' ');

  let result = format
    .replace(/\{label\}/g, label)
    .replace(/\{res\}/g, meta.resolution ?? '')
    .replace(/\{codec\}/g, codec)
    .replace(/\{hdr\}/g, hdr)
    .replace(/\{audio\}/g, audio)
    .replace(/\{fps\}/g, fps);

  // Remove empty bracket / paren pairs that result from missing variables
  result = result.replace(/\[\s*\]/g, '').replace(/\(\s*\)/g, '');
  // Collapse multiple whitespace
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

// ── Strip existing quality tokens from a name ─────────────────────────────────

const QUALITY_STRIP_RE =
  /[\s\-_(]*(8K|UHD|4K|2160p|QHD|1440p|FHD|1080p|HD|720p|SD|480p|RAW)[\s\-_).)]*/gi;

export function stripQualityLabel(name: string): string {
  return name.replace(QUALITY_STRIP_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Compute final display name ─────────────────────────────────────────────────

/**
 * Returns the channel name to display/proxy.
 * - If useDetectedQuality is false, or no detectedMeta.resolution: return base name unchanged.
 * - Otherwise: strip any existing quality label from base, append rendered template suffix.
 */
export function computeDisplayName(
  mapping: Pick<StreamMapping, 'customName' | 'originalName' | 'detectedMeta' | 'useDetectedQuality'>,
  playlistFormat?: string | null,
  globalFormat?: string | null
): string {
  const base = mapping.customName || mapping.originalName;
  if (!mapping.useDetectedQuality || !mapping.detectedMeta?.resolution) return base;
  const format = playlistFormat ?? globalFormat ?? '[{label}]';
  const suffix = renderTemplate(format, mapping.detectedMeta);
  return suffix ? stripQualityLabel(base) + ' ' + suffix : base;
}
