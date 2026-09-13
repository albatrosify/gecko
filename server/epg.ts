import axios from 'axios';
import zlib from 'zlib';
import { promisify } from 'util';
import { EPGSource } from '../src/types';
import { Readable } from 'stream';

const gunzipAsync = promisify(zlib.gunzip);
const MAX_DECOMPRESSED_SIZE = 250 * 1024 * 1024; // 250MB safety limit

export async function fetchEPG(source: EPGSource): Promise<string> {
  try {
    const response = await axios.get(source.url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024, // 100MB cap
    });
    let data = response.data;

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (isGzip) {
      data = (await gunzipAsync(buf, { maxOutputLength: MAX_DECOMPRESSED_SIZE })) as Buffer;
    }

    return data.toString('utf-8');
  } catch (error: any) {
    const safeUrl = (source.url || '').replace(/([?&](?:password|pass|token|secret)=)[^&]*/gi, '$1***');
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch EPG from ${source.name || safeUrl}: ${reason}`);
  }
}

export function streamEPG(_url: string): Readable {
  throw new Error('streamEPG is not implemented yet. Use fetchEPG instead.');
}
