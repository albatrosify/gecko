import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAuthOrQuery, AuthRequest } from './auth.ts';

describe('requireAuthOrQuery', () => {
  const secret = 'test-secret';

  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', secret);
  });

  const createRequest = (headers: any = {}, query: any = {}) => ({
    headers,
    query,
  } as AuthRequest);

  const createResponse = () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  it('should accept valid token in Authorization header', () => {
    const token = jwt.sign({ id: '1', email: 'test@example.com', role: 'user' }, secret);
    const req = createRequest({ authorization: `Bearer ${token}` });
    const res = createResponse();
    const next = vi.fn();

    requireAuthOrQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user?.id).toBe('1');
  });

  it('should reject standard auth token in query parameter', () => {
    // Missing purpose: 'download'
    const token = jwt.sign({ id: '1', email: 'test@example.com', role: 'user' }, secret);
    const req = createRequest({}, { token });
    const res = createResponse();
    const next = vi.fn();

    requireAuthOrQuery(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token purpose for query parameter' });
  });

  it('should accept download ticket in query parameter', () => {
    const token = jwt.sign({ id: '1', email: 'test@example.com', role: 'user', purpose: 'download' }, secret);
    const req = createRequest({}, { token });
    const res = createResponse();
    const next = vi.fn();

    requireAuthOrQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user?.id).toBe('1');
  });

  it('should reject if no token is provided', () => {
    const req = createRequest();
    const res = createResponse();
    const next = vi.fn();

    requireAuthOrQuery(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should reject invalid tokens in query parameter', () => {
    const req = createRequest({}, { token: 'invalid-token' });
    const res = createResponse();
    const next = vi.fn();

    requireAuthOrQuery(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
