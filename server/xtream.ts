import axios from 'axios';
import { UpstreamSource } from '../src/types';
import { log } from './logger.ts';

export class XtreamClient {
  private source: UpstreamSource;
  public lastResponseHeaders: any = null;

  constructor(source: UpstreamSource) {
    this.source = source;
  }

  private get baseUrl() {
    return this.source.url.replace(/\/$/, '');
  }

  private get authParams() {
    return {
      username: this.source.username,
      password: this.source.password,
    };
  }


  private async request(action?: string, extraParams: any = {}, timeoutMs: number = 25000) {
    const params = { ...this.authParams, ...(action ? { action } : {}), ...extraParams };
    const url = `${this.baseUrl}/player_api.php`;
    
    const start = Date.now();
    try {
      const response = await axios.get(url, { 
        params,
        timeout: timeoutMs,
        maxContentLength: 200 * 1024 * 1024,
        maxBodyLength: 200 * 1024 * 1024,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Referer': this.baseUrl + '/',
          'Connection': 'keep-alive'
        }
      });
      this.lastResponseHeaders = response.headers;
      const duration = Date.now() - start;
      log(`[Xtream] GET ${action || 'authenticate'} - ${response.status} (${duration}ms)`);
      log(`[Xtream]   Payload type: ${typeof response.data}`);
      if (typeof response.data === 'string') {
        log(`[Xtream]   String preview: ${response.data.substring(0, 500)}`);
      } else if (Array.isArray(response.data)) {
        log(`[Xtream]   Array size: ${response.data.length} items`);
        if (response.data.length > 0) {
          log(`[Xtream]   First item preview: ${JSON.stringify(response.data[0]).substring(0, 200)}`);
        }
      } else if (response.data && typeof response.data === 'object') {
        const keys = Object.keys(response.data);
        log(`[Xtream]   Object keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''} (${keys.length} total)`);
      }
      
      return response.data;
    } catch (error: any) {
      this.lastResponseHeaders = error.response?.headers || null;
      const duration = Date.now() - start;
      log(`[Xtream] ERROR ${action || 'authenticate'} after ${duration}ms: ${error.message}`);
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)}s to ${url}`);
      }
      throw error;
    }
  }

  async authenticate() {
    return this.request(undefined, {}, 15000);
  }

  async getLiveCategories() {
    return this.request('get_live_categories', {}, 30000);
  }

  async getLiveStreams() {
    return this.request('get_live_streams', {}, 45000);
  }

  async getVodCategories() {
    return this.request('get_vod_categories', {}, 30000);
  }

  async getVodStreams() {
    return this.request('get_vod_streams', {}, 90000);
  }

  async getMovies() {
    return this.getVodStreams();
  }

  async getSeriesCategories() {
    return this.request('get_series_categories', {}, 30000);
  }

  async getSeries() {
    return this.request('get_series', {}, 90000);
  }

  async getLiveInfo(streamId: string) {
    return this.request('get_live_info', { stream_id: streamId });
  }

  async getVodInfo(vodId: string) {
    return this.request('get_vod_info', { vod_id: vodId });
  }

  async getSeriesInfo(seriesId: string) {
    return this.request('get_series_info', { series_id: seriesId });
  }

  async getShortEpg(streamId: string, limit?: number) {
    return this.request('get_short_epg', { stream_id: streamId, ...(limit ? { limit } : {}) });
  }

  async getSimpleDataTable(streamId: string) {
    return this.request('get_simple_data_table', { stream_id: streamId });
  }

  getLiveStreamUrl(streamId: string | number) {
    return `${this.baseUrl}/live/${this.source.username}/${this.source.password}/${streamId}.ts`;
  }

  getVodStreamUrl(streamId: string | number, extension: string = "mp4") {
    return `${this.baseUrl}/movie/${this.source.username}/${this.source.password}/${streamId}.${extension}`;
  }

  getSeriesStreamUrl(streamId: string | number, extension: string = "mp4") {
    return `${this.baseUrl}/series/${this.source.username}/${this.source.password}/${streamId}.${extension}`;
  }
}
