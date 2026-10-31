import fs from 'fs';
import path from 'path';

export const LOG_PATH = path.join(process.cwd(), 'data', 'server.log');

/**
 * Process role, set by the parent when it forks the sync worker. Every line is
 * tagged so interleaved `docker logs` output stays attributable - a catalog-write
 * stall belongs to the worker, not to the process serving the streams.
 */
const ROLE = process.env.GECKO_PROCESS_ROLE;

export function log(msg: string) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}]${ROLE ? ` [${ROLE}]` : ''} ${msg}\n`;
  console.log(entry.trim());
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, entry);
  } catch (e: any) {
    console.error(`Failed to append to log file: ${e?.message || e}`);
  }
}
