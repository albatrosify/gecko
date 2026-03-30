import axios from 'axios';
import { UpstreamSource } from '../src/types';
import fs from 'fs';
import path from 'path';

const LOG_PATH = path.join(process.cwd(), 'data', 'server.log');

function log(msg: string) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}\n`;
  console.log(entry.trim());
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, entry);
  } catch (e) {}
}

export class XtreamClient {
  private source: UpstreamSource;

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


  private async request(action?: string, extraParams: any = {}) {
    const params = { ...this.authParams, ...(action ? { action } : {}), ...extraParams };
    const url = `${this.baseUrl}/player_api.php`;
    
    const start = Date.now();
    try {
      const response = await axios.get(url, { 
        params,
        timeout: 15000, // 15s timeout
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
      const duration = Date.now() - start;
      log(`[Xtream] ERROR ${action || 'authenticate'} after ${duration}ms: ${error.message}`);
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Connection timed out after 10s to ${url}`);
      }
      throw error;
    }
  }

  async authenticate() {
    return this.request();
  }

  async getLiveCategories() {
    return this.request('get_live_categories');
  }

  async getLiveStreams() {
    return this.request('get_live_streams');
  }

  async getVodCategories() {
    return this.request('get_vod_categories');
  }

  async getVodStreams() {
    return this.request('get_vod_streams');
  }

  async getMovies() {
    return this.getVodStreams();
  }

  async getSeriesCategories() {
    return this.request('get_series_categories');
  }

  async getSeries() {
    return this.request('get_series');
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
