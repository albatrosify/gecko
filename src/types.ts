export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface UpstreamSource {
  id: string;
  name: string;
  type: 'xtream' | 'm3u';
  url: string;
  username?: string;
  password?: string;
  enabled: boolean;
  lastUpdated?: string;
  autoSyncEnabled?: boolean;
  syncCron?: string; // Crontab format
  useUpstreamEpg?: boolean; // Proxy this source's xmltv.php as EPG
}

export interface EPGSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface Playlist {
  id: string;
  userId: string;
  name: string;
  username: string; // Custom login for this playlist
  password: string; // Custom login for this playlist
  sourceIds: string[];
  epgIds: string[];
  autoUpdateInterval: string; // Crontab format
  enabled: boolean;
  directStreams?: boolean;
  lastSync?: string; // ISO timestamp
}

export interface CategoryMapping {
  id: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  originalId: string;
  originalName: string;
  customName: string;
  order: number;
  hidden: boolean;
  syncOnDemand?: boolean;
}

export interface StreamMapping {
  id: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  originalId: string;
  originalName: string;
  customName: string;
  customIcon?: string;
  epgMapping?: string;
  epgIcon?: string; // Logo from EPG source, used when no customIcon is set
  epgSource?: string; // Human-readable EPG provider name
  order: number;
  hidden: boolean;
  categoryId: string; // Custom category ID
  regexRenames?: { pattern: string; replacement: string }[];
}

