import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows requests under the limit', () => {
    const middleware = createRateLimiter({ windowMs: 1000, max: 2 });

    const req = { ip: '127.0.0.1' } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks requests over the limit', () => {
    const middleware = createRateLimiter({ windowMs: 1000, max: 1 });

    const req = { ip: '127.0.0.1' } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'Too many requests, please try again later.' });
  });

  it('resets the limit after the window expires', () => {
    const middleware = createRateLimiter({ windowMs: 1000, max: 1 });

    const req = { ip: '127.0.0.1' } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Blocked
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    res.status.mockClear();

    // Advance time
    vi.advanceTimersByTime(1001);

    // Allowed again
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });
});
