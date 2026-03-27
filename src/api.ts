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
    clearToken();
    window.location.reload();
    throw new Error('Authentication expired');
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
      body: JSON.stringify({ updates }),
    });
  },
  async delete(id: string) {
    return request<any>(`/api/mappings/${id}`, { method: 'DELETE' });
  },
};

// Category Mappings
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
  async delete(id: string) {
    return request<any>(`/api/category-mappings/${id}`, { method: 'DELETE' });
  },
};

// Upstream data
export const upstream = {
  async fetchCategories(source: any, forceRefresh = false) {
    return request<any>('/api/fetch-upstream', {
      method: 'POST',
      body: JSON.stringify({ source, forceRefresh }),
    });
  },
  async fetchStreams(source: any, type: string, forceRefresh = false) {
    return request<any>('/api/fetch-streams', {
      method: 'POST',
      body: JSON.stringify({ source, type, forceRefresh }),
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
  async logs() {
    return request<{ logs: string }>('/api/system/logs');
  },
  async ip() {
    return request<{ ip: string; country: string; city: string; org: string }>('/api/system/ip');
  },
};

// Settings
export const settings = {
  async get(): Promise<{ qualityLabelFormat: string }> {
    return request('/api/settings');
  },
  async update(data: { qualityLabelFormat: string }) {
    return request<{ success: boolean }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
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

const api = { auth, sources, epgs, playlists, mappings, categoryMappings, upstream, proxy, admin, system, settings, qualityScan };
export default api;
