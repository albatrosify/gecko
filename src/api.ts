const API_BASE = '';

function getToken(): string | null {
  return localStorage.getItem('auth_token');
}

function setToken(token: string): void {
  localStorage.setItem('auth_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('auth_token');
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    const hadToken = !!token;
    clearToken();
    if (hadToken && path !== '/api/auth/login' && path !== '/api/auth/register') {
      if (typeof window !== 'undefined' && window.location.pathname !== '/') {
        window.location.href = '/';
      }
    }
    const body = await res.json().catch(() => ({ error: 'Authentication expired' }));
    throw new Error(body.error || 'Authentication expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// Auth
export const auth = {
  async register(email: string, password: string) {
    const data = await request<{ token: string; user: any }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(data.token);
    return data.user;
  },

  async login(email: string, password: string) {
    const data = await request<{ token: string; user: any }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(data.token);
    return data.user;
  },

  async me() {
    const data = await request<{ user: any }>('/api/auth/me');
    return data.user;
  },

  logout() {
    clearToken();
  },
};

// Sources
export const sources = {
  async list() {
    return request<any[]>('/api/sources');
  },
  async create(data: any) {
    return request<any>('/api/sources', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(`/api/sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async delete(id: string) {
    return request<any>(`/api/sources/${id}`, { method: 'DELETE' });
  },
  async refresh(id: string) {
    return request<any>(`/api/sources/${id}/refresh`, { method: 'POST' });
  },
  async changelog(id: string) {
    return request<any[]>(`/api/sources/${id}/changelog`);
  },
  async connections(id: string, limit?: number) {
    const query = limit ? `?limit=${limit}` : '';
    return request<any[]>(`/api/sources/${id}/connections${query}`);
  },
  async checkConnection(id: string) {
    return request<{ success: boolean; log: any; error?: string }>(`/api/sources/${id}/connections/check`, {
      method: 'POST',
    });
  },
  async clearConnections(id: string) {
    return request<{ success: boolean }>(`/api/sources/${id}/connections`, {
      method: 'DELETE',
    });
  },
  async benchmark(id: string) {
    return request<any>(`/api/sources/${id}/benchmark`, {
      method: 'POST',
    });
  },
  async hostBenchmarks(id: string, limit?: number) {
    const query = limit ? `?limit=${limit}` : '';
    return request<any[]>(`/api/sources/${id}/host-benchmarks${query}`);
  },
};

// EPGs
export const epgs = {
  async list() {
    return request<any[]>('/api/epgs');
  },
  async create(data: any) {
    return request<any>('/api/epgs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async delete(id: string) {
    return request<any>(`/api/epgs/${id}`, { method: 'DELETE' });
  },
  async channels(playlistId: string) {
    return request<{ channels: { id: string; name: string; icon?: string; source: string }[] }>(`/api/epg-channels?playlistId=${playlistId}`);
  },
};

// Playlists
export const playlists = {
  async list() {
    return request<any[]>('/api/playlists');
  },
  async create(data: any) {
    return request<any>('/api/playlists', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(`/api/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async delete(id: string) {
    return request<any>(`/api/playlists/${id}`, { method: 'DELETE' });
  },
  async clone(id: string, data: { name: string, username?: string, password?: string }) {
    return request<{ id: string }>(`/api/playlists/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async search(id: string, q: string) {
    return request<{ results: { streamId: string; name: string; type: 'live'|'vod'|'series'; categoryId: string; categoryName: string }[] }>(
      `/api/playlists/${id}/search?q=${encodeURIComponent(q)}`
    );
  },
  async seriesInfo(id: string, seriesId: string) {
    return request<any>(`/api/playlists/${id}/series-info?seriesId=${encodeURIComponent(seriesId)}`);
  },
};

// Mappings
export const mappings = {
  async list(playlistId: string) {
    return request<any[]>(`/api/mappings?playlistId=${playlistId}`);
  },
  async create(data: any) {
    return request<any>('/api/mappings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(`/api/mappings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async batchUpdate(updates: any[]) {
    return request<any>('/api/mappings/batch', {
      method: 'POST',
      body: JSON.stringify({ updates })
    });
  },
  async reset(ids: string[]) {
    return request<any>('/api/mappings/reset', {
      method: 'POST',
      body: JSON.stringify({ ids })
    });
  },
  async delete(id: string) {
    return request<any>(`/api/mappings/${id}`, { method: 'DELETE' });
  },
};

// Category Mappings
export const customCategories = {
  async list(playlistId: string) {
    return request<any[]>(`/api/custom-categories?playlistId=${playlistId}`);
  },
  async create(data: any) {
    return request<any>('/api/custom-categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(`/api/custom-categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async remove(id: string) {
    return request<any>(`/api/custom-categories/${id}`, { method: 'DELETE' });
  },
};

export const customCategoryItems = {
  async list(playlistId: string) {
    return request<any[]>(`/api/custom-category-items?playlistId=${playlistId}`);
  },
  async create(data: any) {
    return request<any>('/api/custom-category-items', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async batchCreate(items: any[], playlistId?: string) {
    const pId = playlistId || items[0]?.playlistId;
    return request<any>(`/api/custom-category-items/batch${pId ? `?playlistId=${encodeURIComponent(pId)}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ items, playlistId: pId }),
    });
  },
  async remove(id: string) {
    return request<any>(`/api/custom-category-items/${id}`, { method: 'DELETE' });
  },
};

export const categoryMappings = {
  async list(playlistId: string) {
    return request<any[]>(`/api/category-mappings?playlistId=${playlistId}`);
  },
  async create(data: any) {
    return request<any>('/api/category-mappings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(`/api/category-mappings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async batchUpdate(updates: any[]) {
    return request<any>('/api/category-mappings/batch', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    });
  },
  async reset(ids?: string[], options?: { originalIds?: string[]; playlistId?: string; type?: string }) {
    return request<any>('/api/category-mappings/reset', {
      method: 'POST',
      body: JSON.stringify({ ids, ...options })
    });
  },
  async delete(id: string) {
    return request<any>(`/api/category-mappings/${id}`, { method: 'DELETE' });
  },
};

// Upstream data
export const upstream = {
  async fetchCategories(source: any, forceRefresh = false, sourceIndex?: number) {
    return request<any>('/api/fetch-upstream', {
      method: 'POST',
      body: JSON.stringify({ source, forceRefresh, sourceIndex }),
    });
  },
  async fetchStreams(source: any, type: string, forceRefresh = false, sourceIndex?: number) {
    return request<any>('/api/fetch-streams', {
      method: 'POST',
      body: JSON.stringify({ source, type, forceRefresh, sourceIndex }),
    });
  },
};

// Proxy Stats
export const proxy = {
  async stats() {
    return request<{
      activeStreams: number;
      totalBytes: number;
      currentBps: number;
      totalPlaylists: number;
      totalUsers: number;
      history: { time: number; bps: number }[];
      connections: {
        id: string;
        username: string;
        streamId: string;
        type: string;
        ip: string;
        startTime: number;
        bytesRead: number;
      }[];
    }>('/api/proxy/stats');
  },
};

export const admin = {
  async listUsers() {
    return request<any[]>('/api/admin/users');
  },
  async deleteUser(id: string) {
    return request<any>(`/api/admin/users/${id}`, { method: 'DELETE' });
  }
};

export const system = {
  async logs(limit: number = 500) {
    return request<{ logs: string; totalLines?: number }>(`/api/system/logs?limit=${limit}`);
  },
  async ip() {
    return request<{ ip: string; country: string; city: string; org: string }>('/api/system/ip');
  },
  async vpnStatus() {
    return request<import('./types.ts').VpnStatus>('/api/system/vpn');
  },
  async reconnectVpn() {
    return request<{ success: boolean; message: string; newIp?: string }>('/api/system/vpn/reconnect', {
      method: 'POST',
    });
  },
};

// Settings
export interface GlobalSettings {
  qualityLabelFormat?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramEnabled?: boolean;
}

export const settings = {
  async get(): Promise<GlobalSettings> {
    return request('/api/settings');
  },
  async update(data: Partial<GlobalSettings>) {
    return request<{ success: boolean }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  async testTelegram(botToken?: string, chatId?: string) {
    return request<{ success: boolean }>('/api/settings/telegram/test', {
      method: 'POST',
      body: JSON.stringify({ botToken, chatId }),
    });
  },
};

// Quality Scan
export const qualityScan = {
  async start(body: {
    playlistId: string;
    streamIds: string[];
    type: 'live' | 'vod' | 'series';
    concurrency?: number;
  }): Promise<{ jobId: string }> {
    return request('/api/quality-scan', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async status(jobId: string): Promise<{
    id: string;
    status: 'running' | 'done' | 'cancelled';
    total: number;
    done: number;
    failed: number;
    results: { streamId: string; meta?: any; error?: string }[];
  }> {
    return request(`/api/quality-scan/${jobId}`);
  },
  async cancel(jobId: string): Promise<{ success: boolean }> {
    return request(`/api/quality-scan/${jobId}`, { method: 'DELETE' });
  },
};

// DVR
export const dvr = {
  async getRecordings(): Promise<import('./types').Recording[]> {
    return request('/api/dvr/recordings');
  },
  async recordNow(connectionId: string): Promise<{ success: boolean; recording: import('./types').Recording }> {
    return request('/api/dvr/record-now', {
      method: 'POST',
      body: JSON.stringify({ connectionId }),
    });
  },
  async stopRecording(id: string): Promise<{ success: boolean; recording: import('./types').Recording }> {
    return request(`/api/dvr/recordings/${id}/stop`, {
      method: 'POST',
    });
  },
  async deleteRecording(id: string): Promise<{ success: boolean }> {
    return request(`/api/dvr/recordings/${id}`, {
      method: 'DELETE',
    });
  },
  getStreamUrl(id: string, download: boolean = false): string {
    const token = getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    return `/api/dvr/recordings/${id}/stream?download=${download}${tokenParam}`;
  },
};

const api = { auth, sources, epgs, playlists, mappings, categoryMappings, customCategories, customCategoryItems, upstream, proxy, admin, system, settings, qualityScan, dvr };
export default api;
