import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateM3uContent, sanitizeFilename, getPlayerSchemeUrl, downloadStreamM3u, launchExternalPlayer } from './playerUtils';

describe('playerUtils', () => {
  describe('generateM3uContent', () => {
    it('should generate valid M3U content with stream title and URL', () => {
      const content = generateM3uContent('https://example.com/stream.ts', 'Sky Cinema HD');
      expect(content).toBe('#EXTM3U\n#EXTINF:-1 tvg-name="Sky Cinema HD",Sky Cinema HD\nhttps://example.com/stream.ts\n');
    });

    it('should sanitize newlines in title', () => {
      const content = generateM3uContent('https://example.com/stream.ts', 'Channel\nName\r1');
      expect(content).toBe('#EXTM3U\n#EXTINF:-1 tvg-name="Channel Name 1",Channel Name 1\nhttps://example.com/stream.ts\n');
    });

    it('should fallback to default title if empty', () => {
      const content = generateM3uContent('https://example.com/stream.ts', '');
      expect(content).toBe('#EXTM3U\n#EXTINF:-1 tvg-name="stream",stream\nhttps://example.com/stream.ts\n');
    });
  });

  describe('sanitizeFilename', () => {
    it('should replace invalid characters for filenames', () => {
      expect(sanitizeFilename('TV: Channel / 1 * (HD)?')).toBe('TV_ Channel _ 1 _ (HD)_');
    });

    it('should handle empty or whitespace title', () => {
      expect(sanitizeFilename('   ')).toBe('stream');
    });
  });

  describe('getPlayerSchemeUrl', () => {
    it('should format IINA URL', () => {
      const url = getPlayerSchemeUrl('https://example.com/live.ts', 'iina');
      expect(url).toBe('iina://weblink?url=https%3A%2F%2Fexample.com%2Flive.ts');
    });

    it('should format VLC URL', () => {
      const url = getPlayerSchemeUrl('https://example.com/live.ts', 'vlc');
      expect(url).toBe('vlc://https://example.com/live.ts');
    });

    it('should format PotPlayer URL', () => {
      const url = getPlayerSchemeUrl('https://example.com/live.ts', 'potplayer');
      expect(url).toBe('potplayer://https://example.com/live.ts');
    });

    it('should return null for m3u', () => {
      expect(getPlayerSchemeUrl('https://example.com/live.ts', 'm3u')).toBeNull();
    });
  });

  describe('downloadStreamM3u & launchExternalPlayer', () => {
    let originalDocument: any;
    let originalWindow: any;
    let originalURL: any;

    beforeEach(() => {
      originalDocument = (globalThis as any).document;
      originalWindow = (globalThis as any).window;
      originalURL = (globalThis as any).URL;

      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => 'blob:mock-url'),
        revokeObjectURL: vi.fn(),
      };
      (globalThis as any).window = {
        location: { origin: 'http://localhost:3000' },
      };
    });

    afterEach(() => {
      (globalThis as any).document = originalDocument;
      (globalThis as any).window = originalWindow;
      (globalThis as any).URL = originalURL;
      vi.restoreAllMocks();
    });

    it('should create blob and trigger download for m3u', () => {
      const clickSpy = vi.fn();
      const mockElement: any = {
        set href(val: string) {},
        set download(val: string) {},
        click: clickSpy,
      };

      const appendChildSpy = vi.fn();
      const removeChildSpy = vi.fn();

      (globalThis as any).document = {
        createElement: vi.fn(() => mockElement),
        body: {
          appendChild: appendChildSpy,
          removeChild: removeChildSpy,
        },
      };

      downloadStreamM3u('https://example.com/stream.ts', 'Test Channel');

      expect((globalThis as any).URL.createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(appendChildSpy).toHaveBeenCalledWith(mockElement);
      expect(removeChildSpy).toHaveBeenCalledWith(mockElement);
      expect((globalThis as any).URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('launchExternalPlayer with m3u should call downloadStreamM3u', () => {
      const clickSpy = vi.fn();
      const mockElement: any = {
        set href(val: string) {},
        set download(val: string) {},
        click: clickSpy,
      };

      (globalThis as any).document = {
        createElement: vi.fn(() => mockElement),
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        },
      };

      launchExternalPlayer('https://example.com/stream.ts', 'Test Channel', 'm3u');
      expect(clickSpy).toHaveBeenCalled();
    });
  });
});
