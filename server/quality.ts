import { spawn } from 'child_process';
import { DetectedStreamMeta } from '../src/types.ts';

/**
 * Run ffprobe against a stream URL and return parsed metadata.
 * Rejects if ffprobe exits non-zero, stdout is empty, or timeout is hit.
 */
export async function probeStream(
  url: string,
  timeoutMs = 8000
): Promise<DetectedStreamMeta> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0',
      url,
    ];

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffprobe timeout'));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const data = JSON.parse(stdout);
        resolve(parseProbeResult(data));
      } catch {
        reject(new Error('Failed to parse ffprobe JSON output'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}

function parseProbeResult(data: { streams?: any[] }): DetectedStreamMeta {
  const videoStream = data.streams?.find((s) => s.codec_type === 'video');
  const audioStream = data.streams?.find((s) => s.codec_type === 'audio');
  const meta: DetectedStreamMeta = {};

  if (videoStream) {
    const { width: w, height: h } = videoStream;
    if (w && h) meta.resolution = `${w}x${h}`;

    const cn: string = (videoStream.codec_name ?? '').toLowerCase();
    if (cn) meta.videoCodec = cn;

    // HDR detection via color_transfer and side_data
    const ct: string = videoStream.color_transfer ?? '';
    const sideData: any[] = videoStream.side_data_list ?? [];
    const hasDovi = sideData.some((sd) =>
      (sd.side_data_type ?? '').toLowerCase().includes('dovi')
    );
    const hasHdr10Plus = sideData.some((sd) =>
      (sd.side_data_type ?? '').toLowerCase().includes('hdr10+')
    );

    if (hasDovi) meta.hdr = 'DV';
    else if (hasHdr10Plus) meta.hdr = 'HDR10+';
    else if (ct === 'smpte2084') meta.hdr = 'HDR10';
    else if (ct === 'arib-std-b67') meta.hdr = 'HLG';
    else meta.hdr = null;

    // Frame rate — prefer r_frame_rate, fall back to avg_frame_rate
    const fpsStr: string = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
    if (fpsStr && fpsStr !== '0/0') {
      const parts = fpsStr.split('/').map(Number);
      if (parts.length === 2 && parts[1] > 0) {
        meta.fps = Math.round(parts[0] / parts[1]);
      }
    }
  }

  if (audioStream) {
    const ac: string = (audioStream.codec_name ?? '').toLowerCase();
    if (ac) meta.audioCodec = ac;
    if (audioStream.channels != null) meta.audioChannels = audioStream.channels;
  }

  return meta;
}
