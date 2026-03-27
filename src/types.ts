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

export interface DetectedStreamMeta {
  resolution?: string;        // e.g. "1920x1080"
  videoCodec?: string;        // e.g. "hevc", "h264", "av1"
  hdr?: string | null;        // "HDR10" | "HLG" | "DV" | "HDR10+" | null (SDR)
  fps?: number;               // e.g. 25, 30, 50, 60
  audioCodec?: string;        // e.g. "aac", "eac3", "truehd", "dts", "ac3"
  audioChannels?: number;     // e.g. 2, 6, 8
  scannedAt?: string;         // ISO timestamp
  scanType?: 'p' | 'i';       // progressive or interlaced
  colorDepth?: number;        // e.g. 8, 10, 12
  audioLayout?: string;       // ffprobe channel_layout, e.g. "stereo", "5.1(side)", "7.1"
  videoProfile?: string;      // e.g. "High", "Main", "Main 10", "High 10"
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
  qualityLabelFormat?: string;  // e.g. "[{label}]" — per-playlist template
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
  detectedMeta?: DetectedStreamMeta;
  useDetectedQuality?: boolean;
}

