import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const store = new Map<string, RateLimitRecord>();

  // Periodic cleanup of expired entries to prevent memory exhaustion
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(ip);
      }
    }
  }, Math.max(options.windowMs, 60000)); // Cleanup at least every minute

  return (req: Request, res: Response, next: NextFunction) => {
    // Rely on req.ip (Ensure app.set('trust proxy', 1) is configured in server.ts as per memory)
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let record = store.get(ip);

    if (!record) {
      record = { count: 0, resetTime: now + options.windowMs };
      store.set(ip, record);
    }

    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + options.windowMs;
    }

    record.count++;

    if (record.count > options.max) {
      return res.status(429).json({
        error: options.message || 'Too many requests, please try again later.',
      });
    }

    next();
  };
}
