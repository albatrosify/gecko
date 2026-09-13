import fs from 'fs';
import path from 'path';

export const LOG_PATH = path.join(process.cwd(), 'data', 'server.log');

export function log(msg: string) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}\n`;
  console.log(entry.trim());
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, entry);
  } catch (e: any) {
    console.error(`Failed to append to log file: ${e?.message || e}`);
  }
}
