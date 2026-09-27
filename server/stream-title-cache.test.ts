import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberStreamTitles,
  rememberSeriesInfo,
  getStreamTitle,
  formatEpisodeTitle,
  clearStreamTitleCache,
} from './stream-title-cache.ts';

describe('stream-title-cache', () => {
  beforeEach(() => {
    clearStreamTitleCache();
  });

  describe('formatEpisodeTitle', () => {
    it('formats a standard episode with series name, season, episode, and title', () => {
      const title = formatEpisodeTitle('Breaking Bad', {
        season: 1,
        episode_num: 3,
        title: "...And the Bag's in the River",
      });
      expect(title).toBe("Breaking Bad S01E03 - ...And the Bag's in the River");
    });

    it('formats episode cleanly when title is redundant (e.g. "Episode 1")', () => {
      const title = formatEpisodeTitle('Dark', {
        season: 1,
        episode_num: 1,
        title: 'Episode 1',
      });
      expect(title).toBe('Dark S01E01');
    });

    it('formats episode cleanly when title matches S01E01 pattern', () => {
      const title = formatEpisodeTitle('Stranger Things', {
        season: 2,
        episode_num: 4,
        title: 'S02E04',
      });
      expect(title).toBe('Stranger Things S02E04');
    });

    it('formats episode cleanly when title is missing', () => {
      const title = formatEpisodeTitle('The Office', {
        season: 3,
        episode_num: 5,
      });
      expect(title).toBe('The Office S03E05');
    });

    it('handles missing series name gracefully', () => {
      const title = formatEpisodeTitle(undefined, {
        season: 1,
        episode_num: 5,
        title: 'Pilot',
      });
      expect(title).toBe('S01E05 - Pilot');
    });
  });

  describe('rememberStreamTitles & getStreamTitle', () => {
    it('resolves live stream name by source ID and stream ID', () => {
      rememberStreamTitles('source-1', 'live', [
        { stream_id: 1149626, name: 'DEL 2 EVENT 4' },
        { stream_id: '1149627', name: 'DEL 2 EVENT 5' },
      ]);

      const name = getStreamTitle(['source-1'], 'live', '1149626');
      expect(name).toBe('DEL 2 EVENT 4');
    });

    it('resolves live stream name with prefixed stream ID', () => {
      rememberStreamTitles('source-1', 'live', [
        { stream_id: 1149626, name: 'DEL 2 EVENT 4' },
      ]);

      const name = getStreamTitle(['source-1'], 'live', '0_1149626');
      expect(name).toBe('DEL 2 EVENT 4');
    });

    it('resolves movie/vod stream name', () => {
      rememberStreamTitles('source-1', 'movie', [
        { stream_id: 54321, name: 'Inception (2010)' },
      ]);

      const name = getStreamTitle(['source-1'], 'movie', '54321');
      expect(name).toBe('Inception (2010)');
    });

    it('falls back to generic lookup if source ID does not match directly', () => {
      rememberStreamTitles('source-1', 'live', [
        { stream_id: 1149626, name: 'DEL 2 EVENT 4' },
      ]);

      const name = getStreamTitle(['other-source'], 'live', '1149626');
      expect(name).toBe('DEL 2 EVENT 4');
    });

    it('returns null if stream is not found', () => {
      const name = getStreamTitle(['source-1'], 'live', '999999');
      expect(name).toBeNull();
    });
  });

  describe('rememberSeriesInfo', () => {
    it('indexes all episodes from get_series_info response', () => {
      rememberSeriesInfo('source-1', {
        info: { name: 'Severance' },
        episodes: {
          '1': [
            { id: '1001', season: 1, episode_num: 1, title: 'Good News About Hell' },
            { id: '1002', season: 1, episode_num: 2, title: 'Half Loop' },
          ],
        },
      });

      const ep1 = getStreamTitle(['source-1'], 'series', '1001');
      const ep2 = getStreamTitle(['source-1'], 'series', '1002');

      expect(ep1).toBe('Severance S01E01 - Good News About Hell');
      expect(ep2).toBe('Severance S01E02 - Half Loop');
    });

    it('handles series info when episodes is an array', () => {
      rememberSeriesInfo('source-1', {
        info: { name: 'Mini Series' },
        episodes: [
          { id: 2001, season: 1, episode_num: 1, title: 'Part One' },
        ],
      });

      const ep1 = getStreamTitle(['source-1'], 'series', '2001');
      expect(ep1).toBe('Mini Series S01E01 - Part One');
    });
  });
});
