import axios from 'axios';
import zlib from 'zlib';
import { EPGSource } from '../src/types';
import { Readable } from 'stream';

export async function fetchEPG(source: EPGSource): Promise<string> {
  const response = await axios.get(source.url, { responseType: 'arraybuffer' });
  let data = response.data;

  if (source.url.endsWith('.gz')) {
    data = zlib.gunzipSync(data);
  }

  return data.toString('utf-8');
}

export function streamEPG(url: string): Readable {
  // For large files, we should stream and potentially pipe to a parser
  // This is a placeholder for more complex streaming logic
  const stream = new Readable();
  // ... implementation ...
  return stream;
}
