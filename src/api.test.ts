import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api, { clearToken, isLoggedIn } from './api';

describe('API request error handling', () => {
  const originalLocation = window.location;
  const mockReload = vi.fn();

  beforeEach(() => {
    // Mock fetch
    global.fetch = vi.fn();

    // Mock localStorage
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value.toString();
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        for (const key in store) delete store[key];
      }),
    };
    Object.defineProperty(window, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
    });

    // Mock window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: mockReload },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('should clear token, reload, and throw when status is 401', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      status: 401,
      ok: false,
    });

    await expect(api.sources.list()).rejects.toThrow('Authentication expired');
    expect(window.localStorage.removeItem).toHaveBeenCalledWith('auth_token');
    expect(mockReload).toHaveBeenCalled();
  });

  it('should throw parsed JSON error when response is not ok and body has error', async () => {
    const errorMsg = 'Custom parsed error message';
    (global.fetch as any).mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: vi.fn().mockResolvedValueOnce({ error: errorMsg }),
    });

    await expect(api.sources.list()).rejects.toThrow(errorMsg);
  });

  it('should throw generic error when response is not ok and body is unparsable', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      status: 500,
      ok: false,
      statusText: 'Internal Server Error',
      json: vi.fn().mockRejectedValueOnce(new Error('Syntax error')),
    });

    await expect(api.sources.list()).rejects.toThrow('Internal Server Error');
  });

  it('should throw generic status error when response is not ok and no error string exists', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      status: 503,
      ok: false,
      json: vi.fn().mockResolvedValueOnce({}),
    });

    await expect(api.sources.list()).rejects.toThrow('Request failed: 503');
  });
});
