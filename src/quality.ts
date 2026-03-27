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

// ── Codec / layout display labels ─────────────────────────────────────────────

const VIDEO_CODEC_LABELS: Record<string, string> = {
  hevc: 'H.265', h265: 'H.265', h264: 'H.264', avc: 'H.264',
  av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
};

const AUDIO_CODEC_LABELS: Record<string, string> = {
  eac3: 'DD+', 'e-ac-3': 'DD+', ac3: 'DD', truehd: 'TrueHD',
  dts: 'DTS', 'dts-hd': 'DTS-HD', aac: 'AAC', mp3: 'MP3',
  mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC',
};

const PREMIUM_AUDIO = new Set(['eac3', 'e-ac-3', 'truehd', 'dts', 'dts-hd']);

// ── Build template variable context from metadata ─────────────────────────────

export function buildTemplateContext(meta: DetectedStreamMeta): Record<string, string | number | null> {
  const h = meta.resolution ? parseInt(meta.resolution.split('x')[1] ?? '0', 10) : 0;
  const w = meta.resolution ? parseInt(meta.resolution.split('x')[0] ?? '0', 10) : 0;

  const codecRaw = (meta.videoCodec ?? '').toLowerCase();
  const codec = VIDEO_CODEC_LABELS[codecRaw] ?? (meta.videoCodec ? meta.videoCodec.toUpperCase() : null);

  const audioCodecRaw = (meta.audioCodec ?? '').toLowerCase();
  const audioCodecLabel = AUDIO_CODEC_LABELS[audioCodecRaw] ?? (meta.audioCodec ? meta.audioCodec.toUpperCase() : null);
  const ch = meta.audioChannels ?? null;

  // surround: only notable (5.1, 7.1, Mono) — empty for stereo
  let surround: string | null = null;
  if (ch === 1) surround = 'Mono';
  else if (ch === 6) surround = '5.1';
  else if (ch === 8) surround = '7.1';
  else if (ch != null && ch > 8) surround = `${ch}ch`;

  // premium audio codec only
  const premium = PREMIUM_AUDIO.has(audioCodecRaw) ? (audioCodecLabel ?? null) : null;

  // audio: full label e.g. "DD+ 5.1" or "AAC 2.0"
  const chLabel = ch === 1 ? 'Mono' : ch === 2 ? '2.0' : ch === 6 ? '5.1' : ch === 8 ? '7.1' : ch != null ? `${ch}ch` : null;
  const audio = [audioCodecLabel, chLabel].filter(Boolean).join(' ') || null;

  return {
    label: meta.resolution ? resolutionToLabel(meta.resolution) : null,
    res: meta.resolution ?? null,
    height: h || null,
    width: w || null,
    codec,
    videoCodec: meta.videoCodec ?? null,
    videoProfile: meta.videoProfile ?? null,
    hdr: meta.hdr ?? null,
    fps: meta.fps ?? null,
    audio,
    audioCodec: audioCodecLabel,
    audioChannels: ch,
    audioLayout: meta.audioLayout ?? null,
    surround,
    premium,
    colorDepth: meta.colorDepth ?? null,
    scanType: meta.scanType ?? null,
  };
}

// ── Mini template engine ───────────────────────────────────────────────────────
//
// Syntax:
//   {varName}                          → value or empty string
//   {varName::exists["a"||"b"]}        → "a" if value is truthy, else "b"
//   {varName::=X["a"||"b"]}            → "a" if value == X (string or number)
//   {varName::!=X["a"||"b"]}           → "a" if value != X
//   {varName::>=N["a"||"b"]}           → "a" if numeric value >= N
//   {varName::<=N["a"||"b"]}           → "a" if numeric value <= N
//   {varName::>N["a"||"b"]}            → "a" if numeric value > N
//   {varName::<N["a"||"b"]}            → "a" if numeric value < N
//   {varName::~X["a"||"b"]}            → "a" if value contains X (case-insensitive)
//
// "b" (false branch) is optional — defaults to ""
// Branches can themselves contain nested {var} or {var::cond[...]} expressions
// Empty [] and () after resolution are removed automatically

function resolveValue(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  return String(raw);
}

function evalCondition(
  value: string | number | null | undefined,
  op: string,
  operand: string
): boolean {
  const strVal = value == null ? '' : String(value);
  const numVal = Number(value);
  const numOp = Number(operand);

  switch (op) {
    case 'exists': return value != null && strVal !== '';
    case '=':      return strVal === operand || (!isNaN(numVal) && !isNaN(numOp) && numVal === numOp);
    case '!=':     return strVal !== operand;
    case '>=':     return !isNaN(numVal) && !isNaN(numOp) && numVal >= numOp;
    case '<=':     return !isNaN(numVal) && !isNaN(numOp) && numVal <= numOp;
    case '>':      return !isNaN(numVal) && !isNaN(numOp) && numVal > numOp;
    case '<':      return !isNaN(numVal) && !isNaN(numOp) && numVal < numOp;
    case '~':      return strVal.toLowerCase().includes(operand.toLowerCase());
    default:       return false;
  }
}

// Parse the outermost {…} expression at position `start`, return [result, endIndex]
function parseExpr(
  template: string,
  start: number,
  ctx: Record<string, string | number | null>
): [string, number] {
  // find matching closing }
  let depth = 0;
  let end = start;
  for (let i = start; i < template.length; i++) {
    if (template[i] === '{') depth++;
    else if (template[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const inner = template.slice(start + 1, end);

  // Try to parse as conditional: varName::op["true"||"false"] or varName::op["true"]
  const colonIdx = inner.indexOf('::');
  if (colonIdx !== -1) {
    const varName = inner.slice(0, colonIdx);
    const rest = inner.slice(colonIdx + 2);

    // rest = op["trueBranch"||"falseBranch"] or op["trueBranch"]
    const bracketIdx = rest.indexOf('["');
    if (bracketIdx !== -1) {
      const opStr = rest.slice(0, bracketIdx).trim();
      const branchesStr = rest.slice(bracketIdx + 2, -2); // strip [" and "]

      // split on "||"
      const sepIdx = branchesStr.indexOf('"||"');
      const trueBranch = sepIdx !== -1 ? branchesStr.slice(0, sepIdx) : branchesStr;
      const falseBranch = sepIdx !== -1 ? branchesStr.slice(sepIdx + 4) : '';

      // parse op into operator + operand
      const opMatch = opStr.match(/^(exists|[~]|[!=<>]{1,2})(.*)$/);
      const op = opMatch?.[1] ?? opStr;
      const operand = opMatch?.[2]?.trim() ?? '';

      const value = ctx[varName] ?? null;
      const condResult = evalCondition(value, op, operand);
      const branch = condResult ? trueBranch : falseBranch;
      return [renderTemplate(branch, ctx), end];
    }
  }

  // Simple variable substitution
  const varName = inner.trim();
  return [resolveValue(ctx[varName] ?? null), end];
}

/**
 * Render a quality label template string using a context object built from
 * detected stream metadata. Supports simple variable substitution and
 * conditional expressions.
 *
 * @param template - Template string with {varName} and {varName::op["a"||"b"]} tokens
 * @param ctx - Context object mapping variable names to values
 */
export function renderTemplate(
  template: string,
  ctx: Record<string, string | number | null>
): string {
  let result = '';
  let i = 0;
  while (i < template.length) {
    if (template[i] === '{') {
      const [val, end] = parseExpr(template, i, ctx);
      result += val;
      i = end + 1;
    } else {
      result += template[i];
      i++;
    }
  }
  // Clean up empty brackets/parens and collapse whitespace
  result = result.replace(/\[\s*\]/g, '').replace(/\(\s*\)/g, '');
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
  const format = playlistFormat ?? globalFormat ?? '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]';
  const ctx = buildTemplateContext(mapping.detectedMeta);
  const suffix = renderTemplate(format, ctx);
  return suffix ? stripQualityLabel(base) + ' ' + suffix : base;
}
