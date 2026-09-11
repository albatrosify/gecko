export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface SourceHost {
  url: string;
  label?: string;
  order: number;
  enabled?: boolean;
  latencyMs?: number | null;      // Auth latency measured during benchmark
  authOk?: boolean | null;        // Whether authentication succeeded during benchmark
  throughputMbps?: number | null; // Stream throughput probe result
  probeOk?: boolean | null;       // Whether the throughput probe succeeded
  networkType?: 'cdn' | 'direct' | null; // Detected network routing (CDN vs Direct)
  cdnProvider?: string | null;    // Detected CDN provider (e.g. Cloudflare, CloudFront, Fastly)
  resolvedIp?: string | null;     // Resolved IP address
  lastBenchmark?: string | null;  // ISO timestamp of last benchmark for this host
  uses: number;                   // Successful proxied stream uses
  failures: number;               // Failed proxied stream attempts
  lastUsed?: string | null;       // ISO timestamp of last successful use
  lastError?: string | null;      // Last failure reason
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
  expiryDate?: string | null; // ISO timestamp string or null for Unlimited
  accountStatus?: string;     // e.g. "Active", "Expired", "Disabled"
  maxConnections?: number | string; // e.g. "1", "2"
  monitorEnabled?: boolean;   // Enable periodic connection checks
  monitorInterval?: number;   // Polling interval in seconds (default 60)
  lastMonitorCheck?: string;  // ISO timestamp of last connection check
  lastActiveCons?: number;    // Last checked active connections count
  lastMaxCons?: number;       // Last checked max connections limit
  lastMonitorStatus?: 'ok' | 'external_activity' | 'error';
  lastMonitorError?: string;
  benchmarkStreamId?: string | number | null; // Selected stream for benchmarking (e.g. a 4K channel)
  benchmarkStreamName?: string | null;       // Display name of selected benchmark channel
  hosts?: SourceHost[];       // Ordered list of upstream hosts (fallback + benchmark)
}

export interface SourceConnectionLog {
  id: string;
  sourceId: string;
  timestamp: string;
  activeCons: number;
  maxCons: number;
  geckoStreams: number;
  status: 'ok' | 'external_activity' | 'error';
  isExternal: boolean;
  details?: string;
  extra?: any;
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
  isSynced?: boolean;
  nextStreamId?: number;
  sourceOverrides?: Record<string, { username?: string; password?: string }>;
}

export interface CustomCategory {
  id: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  name: string;
  order: number;
  hidden: boolean;
}

export interface CustomCategoryItem {
  id: string;
  customCategoryId: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  upstreamStreamId: string;
  upstreamSourceId: string;
  streamId: string;
  extra: any;
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
  regexRenames?: { type?: 'regex' | 'string'; pattern: string; replacement: string }[];
  detectedMeta?: DetectedStreamMeta;
  useDetectedQuality?: boolean;
  sourceIdx?: number;
}

