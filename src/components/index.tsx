import React, { useState, useEffect, useCallback, useRef, useMemo, forwardRef } from 'react';
import api from '../api';
import { User, Playlist, UpstreamSource, EPGSource, StreamMapping, CategoryMapping } from '../types';
import { 
  Plus, 
  Play, 
  Trash2, 
  Eye,
  EyeOff,
  Edit2,
  Edit3,
  Check, 
  X, 
  Database, 
  Globe, 
  FileJson,
  ArrowLeft,
  Save,
  ExternalLink,
  RefreshCw,
  Search,
  Tv,
  Film,
  Clapperboard,
  Settings as SettingsIcon,
  LogOut, 
  ChevronRight, 
  ChevronDown, 
  GripVertical,
  Activity,
  Folder,
  Wifi,
  Users,
  LayoutList,
  Copy,
  History,
  Clock
} from 'lucide-react';
import cronstrue from 'cronstrue';
import { Link, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FixedSizeList as List } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import axios from 'axios';
import { computeDisplayName } from '../quality';


function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function ProxyBandwidthCard() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await api.proxy.stats();
        setStats(data);
      } catch (err) {
        // Silently ignore or handle auth error
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return (
    <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-3xl p-6 flex items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
      <div className="text-zinc-500 animate-pulse font-bold tracking-widest text-[10px] uppercase italic">Init Bandwidth Monitor...</div>
    </div>
  );

  const mbps = (stats.currentBps / 1000000).toFixed(2);
  const totalGB = (stats.totalBytes / (1024 * 1024 * 1024)).toFixed(2);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-wrap gap-8 items-center bg-gradient-to-br from-zinc-900 to-zinc-950">
      <div className="flex items-center gap-4">
        <div className="p-3 bg-emerald-500/10 rounded-2xl text-emerald-500 border border-emerald-500/20 shadow-[0_0_15px_-5px] shadow-emerald-500/30">
          <Activity size={24} />
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Proxy Speed</div>
          <div className="text-2xl font-black text-zinc-100 tabular-nums">{mbps} <span className="text-[10px] font-medium text-emerald-500 uppercase tracking-widest">Mbps</span></div>
        </div>
      </div>

      <div className="h-10 w-px bg-zinc-800 hidden sm:block"></div>

      <div className="flex items-center gap-4">
        <div className="p-3 bg-blue-500/10 rounded-2xl text-blue-500 border border-blue-500/20 shadow-[0_0_15px_-5px] shadow-blue-500/30">
          <Wifi size={24} />
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Active Streams</div>
          <div className="text-2xl font-black text-zinc-100 tabular-nums">{stats.activeStreams}</div>
        </div>
      </div>

      <div className="h-10 w-px bg-zinc-800 hidden lg:block"></div>

      <div className="flex items-center gap-4">
        <div className="p-3 bg-purple-500/10 rounded-2xl text-purple-500 border border-purple-500/20 shadow-[0_0_15px_-5px] shadow-purple-500/30">
          <Database size={24} />
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Data Proxied</div>
          <div className="text-2xl font-black text-zinc-100 tabular-nums">{totalGB} <span className="text-[10px] font-medium text-purple-500 uppercase tracking-widest">GB</span></div>
        </div>
      </div>
    </div>
  );
}

function SimpleSparkline({ data, width, height }: { data: number[], width: number, height: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (d / max) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(startTime: number): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const EPG_SOURCE_COLORS = [
  { bg: 'rgba(59,130,246,0.15)',  border: 'rgba(59,130,246,0.3)',  text: '#93c5fd' }, // blue
  { bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.3)', text: '#d8b4fe' }, // purple
  { bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.3)', text: '#6ee7b7' }, // emerald
  { bg: 'rgba(249,115,22,0.15)', border: 'rgba(249,115,22,0.3)', text: '#fdba74' }, // orange
  { bg: 'rgba(236,72,153,0.15)', border: 'rgba(236,72,153,0.3)', text: '#f9a8d4' }, // pink
  { bg: 'rgba(6,182,212,0.15)',  border: 'rgba(6,182,212,0.3)',  text: '#67e8f9' }, // cyan
  { bg: 'rgba(234,179,8,0.15)',  border: 'rgba(234,179,8,0.3)',  text: '#fde047' }, // yellow
  { bg: 'rgba(20,184,166,0.15)', border: 'rgba(20,184,166,0.3)', text: '#5eead4' }, // teal
  { bg: 'rgba(132,204,22,0.15)', border: 'rgba(132,204,22,0.3)', text: '#bef264' }, // lime
  { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.3)',  text: '#fca5a5' }, // red
];

function epgSourceColor(source: string) {
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  return EPG_SOURCE_COLORS[hash % EPG_SOURCE_COLORS.length];
}

function countryToFlag(code: string): string {
  if (!code || code.length !== 2) return '🌐';
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('');
}

function VpnStatusBar() {
  const [ipInfo, setIpInfo] = useState<{ ip: string; country: string; city: string; org: string } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await api.system.ip();
        setIpInfo(data);
        setError(false);
      } catch {
        setError(true);
      }
    };
    fetch();
    const interval = setInterval(fetch, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl px-6 py-4 flex items-center gap-4">
      <div className="flex items-center gap-2 shrink-0">
        {error ? (
          <span className="w-2 h-2 rounded-full bg-amber-500" title="IP lookup unavailable" />
        ) : ipInfo ? (
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-zinc-600 animate-pulse" />
        )}
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Egress IP</span>
      </div>

      {error && (
        <span className="text-xs text-amber-400 font-mono">IP lookup unavailable</span>
      )}

      {!error && !ipInfo && (
        <div className="flex gap-4">
          <div className="h-3 w-28 bg-zinc-800 rounded animate-pulse" />
          <div className="h-3 w-20 bg-zinc-800 rounded animate-pulse" />
        </div>
      )}

      {!error && ipInfo && (
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xl leading-none">{countryToFlag(ipInfo.country)}</span>
            <span className="font-mono text-sm font-bold text-zinc-100 tracking-tight">{ipInfo.ip}</span>
          </div>
          <span className="text-zinc-600">·</span>
          <span className="text-sm text-zinc-400">{[ipInfo.city, ipInfo.country].filter(Boolean).join(', ')}</span>
          {ipInfo.org && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-xs text-zinc-500 font-mono truncate max-w-[240px]">{ipInfo.org}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await api.proxy.stats();
        setStats(data);
      } catch (err) {}
    };
    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return <div className="p-8"><div className="animate-pulse text-zinc-500">Loading Dashboard...</div></div>;

  const mbps = (stats.currentBps / 1000000).toFixed(2);
  const historyMbps = (stats.history || []).map((h: any) => h.bps / 1000000);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <header>
        <h2 className="text-3xl font-black tracking-tight text-zinc-100">Overview</h2>
        <p className="text-zinc-500">Real-time system performance and activity</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Playlists', value: stats.totalPlaylists, icon: LayoutList, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
          { label: 'Active Users', value: stats.totalUsers, icon: Users, color: 'text-blue-500', bg: 'bg-blue-500/10' },
          { label: 'Active Streams', value: stats.activeStreams, icon: Wifi, color: 'text-purple-500', bg: 'bg-purple-500/10' },
          { label: 'Current Speed', value: `${mbps} Mbps`, icon: Activity, color: 'text-orange-500', bg: 'bg-orange-500/10' },
        ].map((card, i) => (
          <div key={i} className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl group hover:border-zinc-700 transition-all">
            <div className="flex justify-between items-start mb-4">
              <div className={`p-3 rounded-2xl ${card.bg} ${card.color} border border-current/10`}>
                <card.icon size={20} />
              </div>
            </div>
            <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">{card.label}</div>
            <div className="text-2xl font-black text-zinc-100 mt-1">{card.value}</div>
          </div>
        ))}
      </div>

      <VpnStatusBar />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-8 flex flex-col">
          <div className="flex justify-between items-center mb-8">
            <div>
              <h3 className="text-xl font-bold">Bandwidth Usage</h3>
              <p className="text-sm text-zinc-500">Real-time throughput (last 2 minutes)</p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-black text-emerald-500 tabular-nums">{mbps} Mbps</div>
              <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Current</div>
            </div>
          </div>
          <div className="flex-1 min-h-[200px] flex items-end text-emerald-500/50">
            <SimpleSparkline data={historyMbps} width={600} height={200} />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-bold">Now Playing</h3>
            {stats.directStreamsCount > 0 && (
              <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-1 rounded-lg uppercase tracking-wider" title="Playlists with Direct Streams bypass the proxy and won't appear here">
                {stats.directStreamsCount} direct stream {stats.directStreamsCount === 1 ? 'playlist' : 'playlists'} not shown
              </span>
            )}
          </div>
          <div className="space-y-4">
            {stats.connections?.length > 0 ? (
              stats.connections.map((conn: any) => {
                const typeColors: Record<string, string> = {
                  live: 'text-orange-400 bg-orange-500/10',
                  movie: 'text-blue-400 bg-blue-500/10',
                  series: 'text-purple-400 bg-purple-500/10',
                };
                const typeColor = typeColors[conn.type] || 'text-zinc-400 bg-zinc-500/10';
                const iconColor = conn.type === 'live' ? 'text-orange-500 bg-orange-500/10'
                  : conn.type === 'movie' ? 'text-blue-500 bg-blue-500/10'
                  : 'text-purple-500 bg-purple-500/10';
                return (
                  <div key={conn.id} className="bg-zinc-800/50 rounded-2xl p-4 space-y-3">
                    {/* Top row: icon + name + type badge */}
                    <div className="flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconColor}`}>
                        <Play size={16} fill="currentColor" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-sm text-zinc-100 truncate leading-tight">{conn.streamName || conn.streamId}</div>
                        <div className="text-xs text-zinc-500 truncate mt-0.5">via <span className="text-zinc-400">{conn.playlistName || conn.username}</span></div>
                      </div>
                      <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg shrink-0 ${typeColor}`}>
                        {conn.type === 'movie' ? 'VOD' : conn.type}
                      </span>
                    </div>
                    {/* Bottom row: stats */}
                    <div className="flex items-center gap-4 flex-wrap pl-12">
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="text-zinc-600">⏱</span>
                        <span className="font-mono text-zinc-400">{formatDuration(conn.startTime)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="text-zinc-600">↓</span>
                        <span className="font-mono text-zinc-400">{formatBytes(conn.bytesRead)}</span>
                      </div>
                      {conn.currentBps > 0 && (
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                          <span className="text-zinc-600">~</span>
                          <span className="font-mono text-zinc-400">{(conn.currentBps / 1_000_000).toFixed(1)} Mbps</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="text-zinc-600">IP</span>
                        <span className="font-mono text-zinc-400">{conn.ip}</span>
                      </div>
                      {conn.proxied && (
                        <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-md uppercase tracking-wider">VPN proxied</span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-12">
                <div className="text-zinc-600 mb-2 font-medium italic">Quiet on the wire...</div>
                <div className="text-[10px] text-zinc-700 uppercase font-bold tracking-widest">No active streams</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlaylistManager({ user }: { user: User }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlaylist, setNewPlaylist] = useState({ name: '', username: '', password: '', directStreams: false });
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloningPlaylist, setCloningPlaylist] = useState<Playlist | null>(null);
  const [cloneData, setCloneData] = useState({ 
    name: '', 
    username: '', 
    password: '',
    sourceUsername: '',
    sourcePassword: ''
  });

  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [editData, setEditData] = useState({ name: '', username: '', password: '', epgIds: [] as string[], qualityLabelFormat: '' });
  const [availableEpgs, setAvailableEpgs] = useState<any[]>([]);

  const loadPlaylists = useCallback(async () => {
    try {
      const data = await api.playlists.list();
      setPlaylists(data);
    } catch (error) {
      console.error('Failed to load playlists:', error);
    }
  }, []);

  useEffect(() => {
    loadPlaylists();
    api.epgs.list().then(setAvailableEpgs).catch(() => {});
  }, [loadPlaylists]);

  const handleAdd = async () => {
    if (!newPlaylist.name || !newPlaylist.username || !newPlaylist.password) return;
    
    try {
      await api.playlists.create(newPlaylist);
      setShowAddModal(false);
      setNewPlaylist({ name: '', username: '', password: '', directStreams: false });
      loadPlaylists();
    } catch (error) {
      console.error('Failed to create playlist:', error);
    }
  };

  const handleClone = async () => {
    if (!cloningPlaylist || !cloneData.name) return;
    try {
      await api.playlists.clone(cloningPlaylist.id, cloneData);
      setShowCloneModal(false);
      setCloningPlaylist(null);
      loadPlaylists();
    } catch (error) {
      console.error('Failed to clone playlist:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.playlists.delete(id);
      loadPlaylists();
    } catch (error) {
      console.error('Failed to delete playlist:', error);
    }
  };

  const handleUpdate = async () => {
    if (!editingPlaylist || !editData.name || !editData.username || !editData.password) return;
    try {
      await api.playlists.update(editingPlaylist.id, { ...editData });
      setShowEditModal(false);
      setEditingPlaylist(null);
      loadPlaylists();
    } catch (error) {
      console.error('Failed to update playlist:', error);
      alert('Failed to update playlist. Ensure username is unique.');
    }
  };

  const handleToggleDirectStreams = async (playlist: Playlist) => {
    try {
      await api.playlists.update(playlist.id, { directStreams: !playlist.directStreams });
      loadPlaylists();
    } catch (error) {
      console.error('Failed to update playlist:', error);
    }
  };

  return (
    <div className="p-8 space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-white">Custom Playlists</h2>
          <p className="text-zinc-500">Manage and configure your IPTV playlists</p>
        </div>
        <button 
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/20"
        >
          <Plus size={20} />
          New Playlist
        </button>
      </header>

      {/* Stats removed as requested, now on Dashboard */}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <h3 className="text-2xl font-bold">New Playlist</h3>
            <div className="space-y-4">
              <input 
                placeholder="Playlist Name" 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={newPlaylist.name}
                onChange={e => setNewPlaylist({ ...newPlaylist, name: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-4">
                <input 
                  placeholder="API Username" 
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                  value={newPlaylist.username}
                  onChange={e => setNewPlaylist({ ...newPlaylist, username: e.target.value })}
                />
                <input 
                  placeholder="API Password" 
                  type="password"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                  value={newPlaylist.password}
                  onChange={e => setNewPlaylist({ ...newPlaylist, password: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-3 p-4 bg-zinc-950 border border-zinc-800 rounded-xl cursor-pointer hover:border-emerald-500/30 transition-all">
                <input 
                  type="checkbox"
                  className="w-5 h-5 rounded border-zinc-800 text-emerald-500 focus:ring-emerald-500 bg-zinc-900"
                  checked={newPlaylist.directStreams}
                  onChange={e => setNewPlaylist({ ...newPlaylist, directStreams: e.target.checked })}
                />
                <div className="flex-1">
                  <div className="font-bold text-sm">Direct Streams</div>
                  <div className="text-[10px] text-zinc-500 leading-tight mt-1">
                    Return the original source stream URLs instead of proxying through this server. Bypasses the proxy completely.
                  </div>
                </div>
              </label>
            </div>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowAddModal(false)}
                className="flex-1 py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleAdd}
                className="flex-1 py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
              >
                Create
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {showCloneModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <div>
              <h3 className="text-2xl font-bold">Duplicate Playlist</h3>
              <p className="text-xs text-zinc-500 mt-1">Copies all categories and mappings. Enter new credentials below.</p>
            </div>
            
            <div className="space-y-6">
              <div className="space-y-4">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">New Playlist Details</label>
                <input 
                  placeholder="New Playlist Name" 
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                  value={cloneData.name}
                  onChange={e => setCloneData({ ...cloneData, name: e.target.value })}
                />
              </div>

              <div className="pt-4 border-t border-zinc-800 space-y-4">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Proxy API Credentials</label>
                  <span className="text-[9px] text-zinc-600 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">End-user Login</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <input 
                    placeholder="Proxy Username" 
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    value={cloneData.username}
                    onChange={e => setCloneData({ ...cloneData, username: e.target.value })}
                  />
                  <input 
                    placeholder="Proxy Password" 
                    type="password"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    value={cloneData.password}
                    onChange={e => setCloneData({ ...cloneData, password: e.target.value })}
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800 space-y-4">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] uppercase font-bold text-emerald-500/70 tracking-wider">Upstream Provider Credentials</label>
                  <span className="text-[9px] text-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 rounded border border-emerald-500/10 text-emerald-500/50 italic">Optional Override</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <input 
                    placeholder="Provider Username" 
                    className="w-full bg-emerald-500/5 border border-zinc-800 rounded-xl p-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    value={cloneData.sourceUsername}
                    onChange={e => setCloneData({ ...cloneData, sourceUsername: e.target.value })}
                  />
                  <input 
                    placeholder="Provider Password" 
                    type="password"
                    className="w-full bg-emerald-500/5 border border-zinc-800 rounded-xl p-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    value={cloneData.sourcePassword}
                    onChange={e => setCloneData({ ...cloneData, sourcePassword: e.target.value })}
                  />
                </div>
                <p className="text-[10px] text-zinc-600 italic">Leave Provider empty to use original credentials.</p>
              </div>
            </div>

            <div className="flex gap-4">
              <button 
                onClick={() => setShowCloneModal(false)}
                className="flex-1 py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleClone}
                className="flex-1 py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
              >
                Duplicate
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {showEditModal && editingPlaylist && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <h3 className="text-2xl font-bold">Edit Playlist Settings</h3>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Playlist Name</label>
                <input 
                  placeholder="name" 
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                  value={editData.name}
                  onChange={e => setEditData({ ...editData, name: e.target.value })}
                />
              </div>
              <div className="pt-4 border-t border-zinc-800 space-y-4">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Proxy API Credentials</label>
                <div className="grid grid-cols-2 gap-4">
                  <input
                    placeholder="API Username"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                    value={editData.username}
                    onChange={e => setEditData({ ...editData, username: e.target.value })}
                  />
                  <input
                    placeholder="API Password"
                    type="text"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                    value={editData.password}
                    onChange={e => setEditData({ ...editData, password: e.target.value })}
                  />
                </div>
              </div>
              <div className="pt-4 border-t border-zinc-800 space-y-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">EPG Sources</label>
                  <p className="text-[10px] text-zinc-600 mt-1">Used for the <code className="text-zinc-500">/xmltv.php</code> endpoint. If none selected, falls back to the upstream provider's EPG.</p>
                </div>
                {availableEpgs.length === 0 ? (
                  <p className="text-xs text-zinc-600 italic">No EPG sources configured. Add them in the EPG Manager.</p>
                ) : (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {availableEpgs.map(epg => (
                      <label key={epg.id} className="flex items-center gap-3 p-3 bg-zinc-950 border border-zinc-800 rounded-xl cursor-pointer hover:border-emerald-500/30 transition-all">
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded border-zinc-700 text-emerald-500 focus:ring-emerald-500 bg-zinc-900"
                          checked={editData.epgIds.includes(epg.id)}
                          onChange={e => {
                            const ids = e.target.checked
                              ? [...editData.epgIds, epg.id]
                              : editData.epgIds.filter((id: string) => id !== epg.id);
                            setEditData({ ...editData, epgIds: ids });
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{epg.name}</div>
                          <div className="text-[10px] text-zinc-600 truncate">{epg.url}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="pt-4 border-t border-zinc-800 space-y-3">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Quality Label Format</label>
                <QualityPresetButtons onSelect={t => setEditData({ ...editData, qualityLabelFormat: t })} />
                <textarea
                  rows={2}
                  placeholder={`${QUALITY_PRESETS[0].template} — leave empty to use global default`}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all resize-none font-mono text-sm"
                  value={editData.qualityLabelFormat ?? ''}
                  onChange={e => setEditData({ ...editData, qualityLabelFormat: e.target.value })}
                />
                <p className="text-[10px] text-zinc-600 mt-1 leading-relaxed select-text">
                  Simple: <span className="font-mono">{'{label}'}</span> · <span className="font-mono">{'{res}'}</span> · <span className="font-mono">{'{codec}'}</span> · <span className="font-mono">{'{hdr}'}</span> · <span className="font-mono">{'{audio}'}</span> · <span className="font-mono">{'{fps}'}</span><br/>
                  Smart (empty when normal): <span className="font-mono">{'{surround}'}</span> (5.1/Mono) · <span className="font-mono">{'{premium}'}</span> (DD+/TrueHD) · <span className="font-mono">{'{hdr}'}</span> (empty if SDR)<br/>
                  More: <span className="font-mono">{'{height}'}</span> · <span className="font-mono">{'{colorDepth}'}</span> · <span className="font-mono">{'{scanType}'}</span> · <span className="font-mono">{'{videoProfile}'}</span> · <span className="font-mono">{'{audioLayout}'}</span><br/>
                  Conditional: <span className="font-mono">{'{{var}::exists["yes"||"no"]}'}</span> · <span className="font-mono">{'{{var}::>=6["5.1"||""]}'}</span>
                </p>
              </div>
            </div>
            <div className="flex gap-4">
              <button 
                onClick={() => { setShowEditModal(false); setEditingPlaylist(null); }}
                className="flex-1 py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleUpdate}
                className="flex-1 py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
              >
                Update
              </button>
            </div>
          </motion.div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {playlists.map((playlist) => (
          <motion.div 
            key={playlist.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-6 hover:border-emerald-500/50 transition-all group"
          >
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <h3 className="text-xl font-bold">{playlist.name}</h3>
                <p className="text-xs text-zinc-500 font-mono uppercase tracking-widest">
                  {playlist.sourceIds.length} Sources · {playlist.enabled ? 'Active' : 'Disabled'}
                </p>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => {
                    setCloningPlaylist(playlist);
                    setCloneData({ 
                      name: `${playlist.name} (Copy)`, 
                      username: playlist.username, 
                      password: playlist.password,
                      sourceUsername: '',
                      sourcePassword: ''
                    });
                    setShowCloneModal(true);
                  }}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-emerald-500"
                  title="Duplicate Playlist"
                >
                  <Copy size={18} />
                </button>
                <button 
                  onClick={() => {
                    setEditingPlaylist(playlist);
                    setEditData({ name: playlist.name, username: playlist.username, password: playlist.password, epgIds: playlist.epgIds || [], qualityLabelFormat: playlist.qualityLabelFormat ?? '' });
                    setShowEditModal(true);
                  }}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100" 
                  title="Edit Settings"
                >
                  <Edit3 size={18} />
                </button>
                <button 
                  onClick={() => handleDelete(playlist.id)}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-red-500"
                  title="Delete"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            <div className="bg-zinc-950 rounded-2xl p-4 border border-zinc-800/50 space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-zinc-500 uppercase font-bold tracking-tighter">API Endpoint</span>
                <button 
                  onClick={() => {
                    const url = `${window.location.origin}/player_api.php?username=${playlist.username}&password=${playlist.password}`;
                    navigator.clipboard.writeText(url);
                  }}
                  className="text-emerald-500 hover:underline flex items-center gap-1"
                >
                  Copy <ExternalLink size={12} />
                </button>
              </div>
              <code className="block text-[10px] text-zinc-400 break-all font-mono">
                {window.location.origin}/player_api.php?username={playlist.username}&password={playlist.password}
              </code>
            </div>

            <div className="flex items-center justify-between px-2">
              <span className="text-xs font-bold text-zinc-400">Direct Streams</span>
              <button
                onClick={() => handleToggleDirectStreams(playlist)}
                className={`w-10 h-5 rounded-full relative transition-colors ${playlist.directStreams ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              >
                <div className={`w-3 h-3 bg-white rounded-full absolute top-1 transition-all ${playlist.directStreams ? 'left-6' : 'left-1'}`} />
              </button>
            </div>

            <Link 
              to={`/playlist/${playlist.id}`}
              className="flex items-center justify-center gap-2 w-full py-3 bg-zinc-800 text-zinc-100 rounded-xl font-bold hover:bg-zinc-700 transition-all"
            >
              <Play size={16} />
              Open Editor
            </Link>
          </motion.div>
        ))}
      </div>

      {playlists.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="p-6 bg-zinc-900 rounded-full text-zinc-700">
            <Tv size={48} />
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-bold">No playlists yet</h3>
            <p className="text-zinc-500 max-w-xs">Create your first aggregated playlist to start editing channels.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function SourceManager({ user }: { user: User }) {
  const [sources, setSources] = useState<UpstreamSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [newSource, setNewSource] = useState<Partial<UpstreamSource>>({ 
    name: '', type: 'xtream', url: '', username: '', password: '', 
    autoSyncEnabled: false, syncCron: '0 2 * * *' 
  });
  const [editingSource, setEditingSource] = useState<UpstreamSource | null>(null);
  const [changelogs, setChangelogs] = useState<any[]>([]);
  const [showChangelog, setShowChangelog] = useState(false);
  const [selectedLogSource, setSelectedLogSource] = useState<any>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [changelogSearch, setChangelogSearch] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  const [syncStatus, setSyncStatus] = useState<Record<string, string>>({});
  const [refreshingSources, setRefreshingSources] = useState<Record<string, boolean>>({});

  const handleShowChangelog = async (source: any) => {
    setSelectedLogSource(source);
    setShowChangelog(true);
    setLoadingLogs(true);
    setChangelogs([]); // Clear old logs
    try {
      const logs = await api.sources.changelog(source.id);
      setChangelogs(logs);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLogs(false);
    }
  };

  const loadSources = useCallback(async () => {
    try {
      const data = await api.sources.list();
      setSources(data);
    } catch (error) {
      console.error('Failed to load sources:', error);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const handleRefresh = async (source: UpstreamSource) => {
    if (!confirm(`Run manual sync for "${source.name}"? This will update any unmodified channel names to match upstream.`)) {
      return;
    }

    setRefreshingSources(prev => ({ ...prev, [source.id]: true }));
    setSyncStatus(prev => ({ ...prev, [source.id]: 'Syncing...' }));

    try {
      const result = await api.sources.refresh(source.id);
      if (result.success) {
        if (result.skipped) {
          setSyncStatus(prev => ({ ...prev, [source.id]: `Success: Recently synced, no refresh needed.` }));
        } else {
          setSyncStatus(prev => ({ ...prev, [source.id]: `Success: ${result.updatedCount ?? 0} channels updated` }));
        }
        loadSources();
      } else {
        setSyncStatus(prev => ({ ...prev, [source.id]: `Error: ${result.error || 'Unknown error'}` }));
      }
    } catch (err: any) {
      setSyncStatus(prev => ({ ...prev, [source.id]: `Error: ${err.message}` }));
    } finally {
      setRefreshingSources(prev => ({ ...prev, [source.id]: false }));
      // Clear status after 10s
      setTimeout(() => {
        setSyncStatus(prev => {
          const newState = { ...prev };
          delete newState[source.id];
          return newState;
        });
      }, 10000);
    }
  };

  const handleAdd = async () => {
    try {
      await api.sources.create(newSource);
      setShowAdd(false);
      setNewSource({ name: '', type: 'xtream', url: '', username: '', password: '', autoSyncEnabled: false, syncCron: '0 2 * * *' });
      loadSources();
    } catch (error) {
      console.error('Failed to create source:', error);
    }
  };

  const handleUpdate = async () => {
    if (!editingSource) return;
    try {
      await api.sources.update(editingSource.id, editingSource);
      setShowEdit(false);
      setEditingSource(null);
      loadSources();
    } catch (error) {
      console.error('Failed to update source:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.sources.delete(id);
      loadSources();
    } catch (error) {
      console.error('Failed to delete source:', error);
    }
  };

  return (
    <div className="p-8 space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Upstream Sources</h2>
          <p className="text-zinc-500">Connect your IPTV providers</p>
        </div>
        <button 
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-400 transition-all"
        >
          <Plus size={20} />
          Add Source
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {sources.map((source) => (
          <div key={source.id} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col gap-6">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-zinc-800 rounded-2xl text-emerald-500">
                  <Database size={24} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold">{source.name}</h3>
                    {source.autoSyncEnabled && (
                      <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded text-[8px] font-black uppercase tracking-tighter flex items-center gap-1">
                        <RefreshCw size={8} />
                        Auto-Sync
                      </span>
                    )}
                    {source.useUpstreamEpg && (
                      <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded text-[8px] font-black uppercase tracking-tighter">
                        EPG
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 font-mono">{source.url}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => handleShowChangelog(source)}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-blue-500 transition-colors"
                  title="View Sync History"
                >
                  <History size={20} />
                </button>
                <button 
                  onClick={() => {
                    setEditingSource({ ...source });
                    setShowEdit(true);
                  }}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-emerald-500 transition-colors"
                >
                  <Edit3 size={20} />
                </button>
                <button 
                  onClick={() => handleDelete(source.id)}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={20} />
                </button>
              </div>
            </div>

            <div className="bg-zinc-950/50 rounded-2xl p-4 border border-zinc-800 flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-[10px] text-zinc-500 uppercase font-black tracking-widest">Last Synced</p>
                <p className="text-xs text-zinc-400 font-medium italic">
                  {source.lastUpdated ? new Date(source.lastUpdated).toLocaleString() : 'Never'}
                </p>
                {syncStatus[source.id] && (
                  <p className={`text-[10px] font-bold ${syncStatus[source.id].startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
                    {syncStatus[source.id]}
                  </p>
                )}
              </div>
              <button 
                onClick={() => handleRefresh(source)}
                disabled={refreshingSources[source.id]}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
              >
                <RefreshCw size={14} className={refreshingSources[source.id] ? 'animate-spin' : ''} />
                {refreshingSources[source.id] ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit Modal */}
      {(showAdd || (showEdit && editingSource)) && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <h3 className="text-2xl font-bold">{showEdit ? 'Edit Upstream Source' : 'Add Upstream Source'}</h3>
            <div className="space-y-4">
              <input 
                placeholder="Source Name" 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={(showEdit ? editingSource! : newSource).name}
                onChange={e => showEdit ? setEditingSource({...editingSource!, name: e.target.value}) : setNewSource({...newSource, name: e.target.value})}
              />
              <select 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={(showEdit ? editingSource! : newSource).type}
                onChange={e => showEdit ? setEditingSource({...editingSource!, type: e.target.value as any}) : setNewSource({...newSource, type: e.target.value as any})}
              >
                <option value="xtream">Xtream Codes</option>
                <option value="m3u">M3U Playlist URL</option>
              </select>
              <input 
                placeholder="Server URL" 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={(showEdit ? editingSource! : newSource).url}
                onChange={e => showEdit ? setEditingSource({...editingSource!, url: e.target.value}) : setNewSource({...newSource, url: e.target.value})}
              />
              {(showEdit ? editingSource! : newSource).type === 'xtream' && (
                <div className="grid grid-cols-2 gap-4">
                  <input 
                    placeholder="Username" 
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                    value={(showEdit ? editingSource! : newSource).username}
                    onChange={e => showEdit ? setEditingSource({...editingSource!, username: e.target.value}) : setNewSource({...newSource, username: e.target.value})}
                  />
                  <input 
                    placeholder="Password" 
                    type="password"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                    value={(showEdit ? editingSource! : newSource).password}
                    onChange={e => showEdit ? setEditingSource({...editingSource!, password: e.target.value}) : setNewSource({...newSource, password: e.target.value})}
                  />
                </div>
              )}

              {/* Sync Settings */}
              <div className="pt-4 border-t border-zinc-800 space-y-4">
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    className="w-5 h-5 rounded border-zinc-800 text-emerald-500 focus:ring-emerald-500 bg-zinc-950"
                    checked={!!(showEdit ? editingSource! : newSource).autoSyncEnabled}
                    onChange={e => showEdit ? setEditingSource({...editingSource!, autoSyncEnabled: e.target.checked}) : setNewSource({...newSource, autoSyncEnabled: e.target.checked})}
                  />
                  <div className="flex-1">
                    <div className="font-bold text-sm group-hover:text-emerald-500 transition-colors">Enable Auto-Sync</div>
                    <div className="text-[10px] text-zinc-500">Periodically refresh channel names from upstream</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    className="w-5 h-5 rounded border-zinc-800 text-emerald-500 focus:ring-emerald-500 bg-zinc-950"
                    checked={!!(showEdit ? editingSource! : newSource).useUpstreamEpg}
                    onChange={e => showEdit ? setEditingSource({...editingSource!, useUpstreamEpg: e.target.checked}) : setNewSource({...newSource, useUpstreamEpg: e.target.checked})}
                  />
                  <div className="flex-1">
                    <div className="font-bold text-sm group-hover:text-emerald-500 transition-colors">Use Upstream EPG</div>
                    <div className="text-[10px] text-zinc-500">Include this source's EPG guide (<code className="text-zinc-400">/xmltv.php</code>) in the playlist EPG export</div>
                  </div>
                </label>

                {(showEdit ? editingSource! : newSource).autoSyncEnabled && (
                  <div className="space-y-2 pl-8 animate-in slide-in-from-top-2 duration-200">
                    <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Update Schedule (Cron Format)</label>
                    <input 
                      placeholder="e.g. 0 2 * * * (Every day at 2:00 AM)" 
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm focus:border-emerald-500 outline-none transition-all font-mono"
                      value={(showEdit ? editingSource! : newSource).syncCron || ""}
                      onChange={e => showEdit ? setEditingSource({...editingSource!, syncCron: e.target.value}) : setNewSource({...newSource, syncCron: e.target.value})}
                    />
                    {(showEdit ? editingSource! : newSource).syncCron && (
                      <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-xl">
                        <Activity size={12} className="text-emerald-500" />
                        <span className="text-[11px] text-emerald-500/80 font-medium italic">
                          {(() => {
                            try {
                              return cronstrue.toString((showEdit ? editingSource! : newSource).syncCron!);
                            } catch (e) {
                              return "Invalid cron expression";
                            }
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-4">
              <button 
                onClick={() => {
                  setShowAdd(false);
                  setShowEdit(false);
                  setEditingSource(null);
                }}
                className="flex-1 py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={showEdit ? handleUpdate : handleAdd}
                className="flex-1 py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
              >
                {showEdit ? 'Save Changes' : 'Add Source'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
      {showChangelog && selectedLogSource && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-6"
          >
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-500/10 rounded-2xl text-blue-500">
                  <History size={24} />
                </div>
                <div>
                  <h3 className="text-2xl font-bold">Sync History</h3>
                  <p className="text-sm text-zinc-500 font-medium italic">{selectedLogSource.name}</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowChangelog(false); setSelectedLogSource(null); setChangelogSearch(''); setExpandedSections({}); }}
                className="p-2 hover:bg-zinc-800 rounded-xl text-zinc-500 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {!loadingLogs && changelogs.length > 0 && (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter by channel name..."
                  value={changelogSearch}
                  onChange={e => setChangelogSearch(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-xl pl-8 pr-4 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                />
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
              {loadingLogs ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  <RefreshCw size={32} className="text-zinc-700 animate-spin" />
                  <p className="text-sm text-zinc-500 font-bold uppercase tracking-tighter">Loading History...</p>
                </div>
              ) : changelogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4 opacity-50 grayscale">
                  <Clock size={32} className="text-zinc-700" />
                  <p className="text-sm text-zinc-500 font-bold tracking-tighter uppercase">No history found for this source</p>
                </div>
              ) : (
                changelogs.map((log: any, idx: number) => {
                  const q = changelogSearch.trim().toLowerCase();
                  const filteredAdded = q ? (log.added || []).filter((item: any) => item.name?.toLowerCase().includes(q)) : (log.added || []);
                  const filteredRemoved = q ? (log.removed || []).filter((item: any) => item.name?.toLowerCase().includes(q)) : (log.removed || []);
                  if (q && filteredAdded.length === 0 && filteredRemoved.length === 0) return null;
                  const addedKey = `${idx}-added`;
                  const removedKey = `${idx}-removed`;
                  const showAllAdded = expandedSections[addedKey] || !!q;
                  const showAllRemoved = expandedSections[removedKey] || !!q;
                  return (
                  <div key={idx} className="bg-zinc-950/50 rounded-2xl border border-zinc-800 p-5 space-y-4">
                    <div className="flex justify-between items-center border-b border-zinc-800 pb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${
                          log.type === 'categories' ? 'bg-purple-500/10 text-purple-400' : 'bg-emerald-500/10 text-emerald-400'
                        }`}>
                          {log.type}
                        </span>
                        <span className="text-xs text-zinc-500 font-bold">{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                      <div className="flex gap-4">
                        {(log.totalAdded || 0) > 0 && <span className="text-[10px] font-bold text-emerald-500">+{log.totalAdded} Added</span>}
                        {(log.totalRemoved || 0) > 0 && <span className="text-[10px] font-bold text-red-500">-{log.totalRemoved} Removed</span>}
                        {(log.totalRenamed || 0) > 0 && <span className="text-[10px] font-bold text-blue-400">{log.totalRenamed} Renamed</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {filteredAdded.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[8px] uppercase font-black tracking-widest text-zinc-600">Added Items</p>
                          <div className="space-y-1">
                            {(showAllAdded ? filteredAdded : filteredAdded.slice(0, 5)).map((item: any, i: number) => (
                              <div key={i} className="text-[11px] text-zinc-400 flex items-center gap-1.5 truncate">
                                <Plus size={8} className="text-emerald-500 shrink-0" />
                                {item.name}
                              </div>
                            ))}
                            {!showAllAdded && filteredAdded.length > 5 && (
                              <button
                                onClick={() => setExpandedSections(prev => ({ ...prev, [addedKey]: true }))}
                                className="text-[9px] text-zinc-500 italic hover:text-zinc-300 transition-colors cursor-pointer"
                              >
                                ...and {filteredAdded.length - 5} more
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      {filteredRemoved.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[8px] uppercase font-black tracking-widest text-zinc-600">Removed Items</p>
                          <div className="space-y-1">
                            {(showAllRemoved ? filteredRemoved : filteredRemoved.slice(0, 5)).map((item: any, i: number) => (
                              <div key={i} className="text-[11px] text-zinc-400 flex items-center gap-1.5 truncate line-through opacity-50">
                                <X size={8} className="text-red-500 shrink-0" />
                                {item.name}
                              </div>
                            ))}
                            {!showAllRemoved && filteredRemoved.length > 5 && (
                              <button
                                onClick={() => setExpandedSections(prev => ({ ...prev, [removedKey]: true }))}
                                className="text-[9px] text-zinc-500 italic hover:text-zinc-300 transition-colors cursor-pointer"
                              >
                                ...and {filteredRemoved.length - 5} more
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      {(!log.added?.length && !log.removed?.length && log.renamed?.length > 0) && (
                        <div className="col-span-2 space-y-1.5">
                          <p className="text-[8px] uppercase font-black tracking-widest text-zinc-600">Renamed Items</p>
                          <div className="text-[11px] text-zinc-500 italic">
                            {log.renamed.length} items were renamed upstream
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })
              )}
            </div>

            <button
              onClick={() => { setShowChangelog(false); setSelectedLogSource(null); setChangelogSearch(''); setExpandedSections({}); }}
              className="w-full py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all text-sm"
            >
              Close History
            </button>
          </motion.div>
        </div>
      )}
    </div>
  );
}

export function EPGManager
({ user }: { user: User }) {
  const [epgs, setEpgs] = useState<EPGSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newEpg, setNewEpg] = useState({ name: '', url: '' });

  const loadEpgs = useCallback(async () => {
    try {
      const data = await api.epgs.list();
      setEpgs(data);
    } catch (error) {
      console.error('Failed to load EPGs:', error);
    }
  }, []);

  useEffect(() => {
    loadEpgs();
  }, [loadEpgs]);

  const handleAdd = async () => {
    try {
      await api.epgs.create(newEpg);
      setShowAdd(false);
      setNewEpg({ name: '', url: '' });
      loadEpgs();
    } catch (error) {
      console.error('Failed to create EPG:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.epgs.delete(id);
      loadEpgs();
    } catch (error) {
      console.error('Failed to delete EPG:', error);
    }
  };

  return (
    <div className="p-8 space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">EPG Providers</h2>
          <p className="text-zinc-500">Manage your XMLTV guides</p>
        </div>
        <button 
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-400 transition-all"
        >
          <Plus size={20} />
          Add EPG
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {epgs.map((epg) => (
          <div key={epg.id} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex justify-between items-center">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-zinc-800 rounded-2xl text-emerald-500">
                <Tv size={24} />
              </div>
              <div>
                <h3 className="font-bold">{epg.name}</h3>
                <p className="text-xs text-zinc-500 font-mono">{epg.url}</p>
              </div>
            </div>
            <button 
              onClick={() => handleDelete(epg.id)}
              className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-red-500 transition-colors"
            >
              <Trash2 size={20} />
            </button>
          </div>
        ))}
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <h3 className="text-2xl font-bold">Add EPG Provider</h3>
            <div className="space-y-4">
              <input 
                placeholder="EPG Name" 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={newEpg.name}
                onChange={e => setNewEpg({...newEpg, name: e.target.value})}
              />
              <input 
                placeholder="XMLTV URL (supports .gz)" 
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
                value={newEpg.url}
                onChange={e => setNewEpg({...newEpg, url: e.target.value})}
              />
            </div>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowAdd(false)}
                className="flex-1 py-3 bg-zinc-800 rounded-xl font-bold hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleAdd}
                className="flex-1 py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
              >
                Save EPG
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

const QUALITY_PRESETS: { label: string; description: string; template: string }[] = [
  {
    label: 'Standard',
    description: '[5.1] [HDR10] [FHD]',
    template: '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]',
  },
  {
    label: 'Minimal',
    description: '[FHD]',
    template: '[{label}]',
  },
  {
    label: 'Verbose',
    description: '[5.1] [DD+] [HDR10] [FHD] [H.265]',
    template: '{surround::exists["[{surround}] "||""]}{premium::exists["[{premium}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}] [{codec}]',
  },
  {
    label: 'No brackets',
    description: '5.1 HDR10 FHD',
    template: '{surround::exists["{surround} "||""]}{hdr::exists["{hdr} "||""]}{label}',
  },
];

function QualityPresetButtons({ onSelect }: { onSelect: (t: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {QUALITY_PRESETS.map(p => (
        <button
          key={p.label}
          type="button"
          onClick={() => onSelect(p.template)}
          title={p.template}
          className="px-2 py-0.5 text-[10px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-emerald-500/50 rounded-lg text-zinc-400 hover:text-zinc-100 transition-all"
        >
          {p.label} <span className="text-zinc-600">{p.description}</span>
        </button>
      ))}
    </div>
  );
}

export function Settings({ user }: { user: User }) {
  const [logs, setLogs] = useState<string>('Loading logs...');
  const logRef = useRef<HTMLPreElement>(null);
  const [qualityFormat, setQualityFormat] = useState<string>('[{label}]');
  const [qualityFormatSaving, setQualityFormatSaving] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.system.logs();
      setLogs(data.logs || 'Waiting for system activity...');
    } catch (err: any) {
      console.error("Log fetch error:", err);
      setLogs(`Error: ${err.message || 'Failed to fetch'}`);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    api.settings.get()
      .then(s => setQualityFormat(s.qualityLabelFormat ?? '[{label}]'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function saveQualityFormat() {
    setQualityFormatSaving(true);
    try {
      await api.settings.update({ qualityLabelFormat: qualityFormat });
    } catch (err: any) {
      console.error('Failed to save quality format:', err);
    } finally {
      setQualityFormatSaving(false);
    }
  }

  return (
    <div className="p-8 space-y-8 max-w-6xl mx-auto">
      <header>
        <h2 className="text-3xl font-black tracking-tight text-zinc-100">Settings</h2>
        <p className="text-zinc-500">Global application configuration and monitoring</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 space-y-6">
            <div className="space-y-2">
              <h3 className="text-xl font-bold">User Profile</h3>
              <p className="text-sm text-zinc-500">Logged in as <span className="text-zinc-100 font-mono">{user.email}</span></p>
              <p className="text-xs text-zinc-600">Role: <span className="text-zinc-400 font-mono uppercase tracking-tighter">{user.role}</span></p>
            </div>
            
            <div className="pt-6 border-t border-zinc-800 space-y-4">
              <div className="flex justify-between items-center opacity-50 grayscale cursor-not-allowed">
                <div>
                  <h4 className="font-bold text-sm">Advanced Analytics</h4>
                  <p className="text-[10px] text-zinc-500">Coming soon</p>
                </div>
                <div className="w-10 h-5 bg-zinc-800 rounded-full relative">
                  <div className="absolute left-1 top-1 w-3 h-3 bg-zinc-600 rounded-full"></div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 space-y-6">
            <div className="space-y-2">
              <h3 className="text-xl font-bold">Quality Labels</h3>
              <p className="text-sm text-zinc-500">Default format for quality labels in channel names</p>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-medium text-zinc-400">Label Format</label>
              <div className="space-y-2">
                <QualityPresetButtons onSelect={t => setQualityFormat(t)} />
                <textarea
                  rows={2}
                  value={qualityFormat}
                  onChange={e => setQualityFormat(e.target.value)}
                  placeholder={QUALITY_PRESETS[0].template}
                  className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 resize-none font-mono text-sm"
                />
                <button
                  onClick={saveQualityFormat}
                  disabled={qualityFormatSaving}
                  className="px-6 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 rounded-xl font-bold hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {qualityFormatSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
              <p className="text-[10px] text-zinc-600 mt-1 leading-relaxed select-text">
                Simple: <span className="font-mono">{'{label}'}</span> · <span className="font-mono">{'{res}'}</span> · <span className="font-mono">{'{codec}'}</span> · <span className="font-mono">{'{hdr}'}</span> · <span className="font-mono">{'{audio}'}</span> · <span className="font-mono">{'{fps}'}</span><br/>
                Smart (empty when normal): <span className="font-mono">{'{surround}'}</span> (5.1/Mono) · <span className="font-mono">{'{premium}'}</span> (DD+/TrueHD) · <span className="font-mono">{'{hdr}'}</span> (empty if SDR)<br/>
                More: <span className="font-mono">{'{height}'}</span> · <span className="font-mono">{'{colorDepth}'}</span> · <span className="font-mono">{'{scanType}'}</span> · <span className="font-mono">{'{videoProfile}'}</span> · <span className="font-mono">{'{audioLayout}'}</span><br/>
                Conditional: <span className="font-mono">{'{{var}::exists["yes"||"no"]}'}</span> · <span className="font-mono">{'{{var}::>=6["5.1"||""]}'}</span>
              </p>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 space-y-4 shadow-2xl shadow-red-500/5">
            <div className="flex items-center gap-2 text-red-500 mb-2">
              <Trash2 size={18} />
              <h3 className="text-lg font-bold">Danger Zone</h3>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">Careful: These actions permanently delete data and cannot be recovered.</p>
            <button className="w-full py-3 border border-red-500/30 text-red-500 rounded-xl font-bold hover:bg-red-500 hover:text-white transition-all text-sm">
              Delete All Cache
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-zinc-400">
               <Activity size={18} className="text-emerald-500" />
               <h3 className="font-bold">System Logs</h3>
            </div>
            <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Live Monitoring
            </div>
          </div>
          
          <div className="bg-zinc-950 border border-zinc-800 rounded-3xl p-6 relative overflow-hidden group">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500/0 via-emerald-500/50 to-emerald-500/0 opacity-0 group-hover:opacity-100 transition-opacity" />
            <pre 
              ref={logRef}
              className="font-mono text-[11px] leading-relaxed text-zinc-400 overflow-y-auto max-h-[500px] scrollbar-hide selection:bg-emerald-500/20"
            >
              {logs}
            </pre>
          </div>
          <p className="text-[10px] text-zinc-600 italic">Showing last 200 activity lines</p>
        </div>
      </div>
    </div>
  );
}



export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 text-zinc-100 p-8 text-center space-y-6">
          <div className="p-6 bg-red-500/10 rounded-full text-red-500">
            <SettingsIcon size={48} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Something went wrong</h2>
            <p className="text-zinc-500 max-w-md mx-auto">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
          </div>
          <button 
            onClick={() => window.location.reload()}
            className="px-8 py-3 bg-zinc-100 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-500 hover:text-zinc-100 transition-all"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PlaylistEditor({ user }: { user: User }) {
  const { id } = useParams();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [sources, setSources] = useState<UpstreamSource[]>([]);
  const [activeTab, setActiveTab] = useState<'live' | 'vod' | 'series'>('live');
  const [categories, setCategories] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [mappings, setMappings] = useState<StreamMapping[]>([]);
  const [categoryMappings, setCategoryMappings] = useState<CategoryMapping[]>([]);
  const [epgChannels, setEpgChannels] = useState<{id: string; name: string; icon?: string; source: string}[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categorySearch, setCategorySearch] = useState('');
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [lastSelectedCategoryId, setLastSelectedCategoryId] = useState<string | null>(null);
  
  const [selectedStreamIds, setSelectedStreamIds] = useState<Set<string>>(new Set());
  const [lastSelectedStreamId, setLastSelectedStreamId] = useState<string | null>(null);
  const [globalFormat, setGlobalFormat] = useState<string>('[{label}]');

  useEffect(() => {
    api.settings.get().then(s => setGlobalFormat(s.qualityLabelFormat ?? '[{label}]')).catch(() => {});
  }, []);

  const loadPlaylistData = useCallback(async () => {
    if (!id) return;
    try {
      const [playlistData, mappingData, catMappingData, epgData] = await Promise.all([
        api.playlists.list().then(list => list.find(p => p.id === id) || null),
        api.mappings.list(id),
        api.categoryMappings.list(id),
        api.epgs.channels(id).catch(() => ({ channels: [] })),
      ]);
      setPlaylist(playlistData);
      setMappings(mappingData);
      setCategoryMappings(catMappingData);
      setEpgChannels(epgData.channels);
    } catch (error) {
      console.error('Failed to load playlist data:', error);
    }
  }, [id]);

  useEffect(() => {
    loadPlaylistData();
  }, [loadPlaylistData]);

  useEffect(() => {
    if (!playlist) return;
    const fetchSources = async () => {
      try {
        const allSources = await api.sources.list();
        setSources(allSources.filter(s => playlist.sourceIds.includes(s.id)));
      } catch (error) {
        console.error('Failed to load sources:', error);
      }
    };
    fetchSources();
  }, [playlist]);

  const loadData = async (forceRefresh = false) => {
    if (!sources.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const source = sources[0];
      const catData = await api.upstream.fetchCategories(source, forceRefresh);
      const streamData = await api.upstream.fetchStreams(source, activeTab, forceRefresh);
      
      const cats = activeTab === 'live' ? catData.liveCats : activeTab === 'vod' ? catData.vodCats : catData.seriesCats;
      setCategories(cats || []);
      setStreams(streamData.streams || []);
      setLastUpdated(catData.lastUpdated);
      setIsCached(catData.cached);
    } catch (error) {
      console.error("Failed to load data", error);
    }
    setLoading(false);
  };

  useEffect(() => {
    setSelectedCategoryIds(new Set());
    setLastSelectedCategoryId(null);
    setSelectedStreamIds(new Set());
    setLastSelectedStreamId(null);
    setStreams([]);
    setCategories([]);
    setSearchTerm('');
    loadData();
  }, [sources, activeTab]);


  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);

  const handleCategoryDragStart = (event: any) => {
    setActiveCategoryId(event.active.id?.toString() || null);
  };

  const handleCategoryDragEnd = async (event: any) => {
    setActiveCategoryId(null);
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      const activeId = active.id.toString();
      const overId = over.id.toString();
      
      const isMulti = selectedCategoryIds.has(activeId);
      const activeIds = isMulti ? Array.from(selectedCategoryIds) : [activeId];
      
      const oldIndex = sortedCategories.findIndex((i) => String(i.category_id || i.id) === activeId);
      const newIndex = sortedCategories.findIndex((i) => String(i.category_id || i.id) === overId);
      
      if (oldIndex === -1 || newIndex === -1) return;

      let newOrder = [...sortedCategories];
      const draggedItems = newOrder.filter(c => activeIds.includes(String(c.category_id || c.id)));
      newOrder = newOrder.filter(c => !activeIds.includes(String(c.category_id || c.id)));
      
      const insertIndex = newOrder.findIndex((i) => String(i.category_id || i.id) === overId);
      const isDraggingDown = oldIndex < newIndex;
      const adjustedInsertIndex = insertIndex !== -1 ? (isDraggingDown ? insertIndex + 1 : insertIndex) : newIndex;
      
      newOrder.splice(adjustedInsertIndex, 0, ...draggedItems);

      setCategories(newOrder); // Optimistic UI update
      
      try {
        const updates = newOrder.map((c, idx) => {
          const catId = String(c.category_id || c.id);
          const mapping = categoryMappings.find(m => m.originalId === catId && m.type === activeTab);
          return {
            id: mapping?.id,
            originalId: catId,
            playlistId: id,
            type: activeTab,
            order: idx
          };
        });

        setCategoryMappings(prev => {
          const next = [...prev];
          updates.forEach(u => {
            const existingIdx = next.findIndex(m => m.originalId === u.originalId && m.type === activeTab);
            if (existingIdx !== -1) {
              next[existingIdx] = { ...next[existingIdx], order: u.order } as any;
            } else {
              next.push(u as any);
            }
          });
          return next;
        });

        await api.categoryMappings.batchUpdate(updates);
      } catch (error) {
        console.error('Failed to update category order:', error);
        refreshMappings();
      }
    }
  };

  const handleBatchMoveToTop = async (scope: 'categories' | 'streams') => {
    setLoading(true);
    try {
      if (scope === 'categories') {
        const selected = Array.from(selectedCategoryIds);
        const moving = sortedCategories.filter(c => selected.includes(String(c.category_id || c.id)));
        const other = sortedCategories.filter(c => !selected.includes(String(c.category_id || c.id)));
        const newOrder = [...moving, ...other];
        
        setCategories(newOrder);
        const updates = newOrder.map((c, idx) => {
          const catId = String(c.category_id || c.id);
          const mapping = categoryMappings.find(m => m.originalId === catId && m.type === activeTab);
          return { id: mapping?.id, originalId: catId, playlistId: id, type: activeTab, order: idx };
        });
        await api.categoryMappings.batchUpdate(updates);
      } else {
        const selected = Array.from(selectedStreamIds);
        const moving = sortedStreams.filter(s => selected.includes(s._uniqueId));
        const other = sortedStreams.filter(s => !selected.includes(s._uniqueId));
        const newOrder = [...moving, ...other];
        
        const updates = newOrder.map((s, idx) => {
          const mapping = mappings.find(m => m.originalId === s._uniqueId && m.type === activeTab);
          return { 
            id: mapping?.id, 
            originalId: s._uniqueId, 
            playlistId: id, 
            type: activeTab, 
            order: idx,
            originalName: s.name || s.title || "",
            customName: mapping?.customName || s.name || s.title || "",
            categoryId: String(s.category_id)
          };
        });
        await api.mappings.batchUpdate(updates);
      }
      refreshMappings();
    } catch (error) {
      console.error('Batch move to top failed:', error);
    }
    setLoading(false);
  };

  const handleStreamDragEnd = async (event: any) => {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      const activeId = active.id.toString();
      const overId = over.id.toString();
      
      const isMulti = selectedStreamIds.has(activeId);
      const activeIds = isMulti ? Array.from(selectedStreamIds) : [activeId];
      
      const oldIndex = filteredStreams.findIndex((i) => i._uniqueId === activeId);
      const newIndex = filteredStreams.findIndex((i) => i._uniqueId === overId);
      
      if (oldIndex === -1 || newIndex === -1) return;

      let newOrder = [...filteredStreams];
      const draggedItems = newOrder.filter(s => activeIds.includes(s._uniqueId));
      newOrder = newOrder.filter(s => !activeIds.includes(s._uniqueId));
      
      const insertIndex = newOrder.findIndex((i) => i._uniqueId === overId);
      const isDraggingDown = oldIndex < newIndex;
      const adjustedInsertIndex = insertIndex !== -1 ? (isDraggingDown ? insertIndex + 1 : insertIndex) : newIndex;
      
      newOrder.splice(adjustedInsertIndex, 0, ...draggedItems);

      try {
        const updates = newOrder.map((s, idx) => {
          const originalId = s._uniqueId;
          const originalName = s.name || s.title || "";
          const mapping = mappings.find(m => m.originalId === originalId && m.type === activeTab);
          
          return {
            id: mapping?.id,
            playlistId: id!,
            type: activeTab,
            originalId,
            originalName,
            customName: mapping?.customName || originalName,
            order: idx,
            hidden: mapping?.hidden || false,
            categoryId: s.category_id.toString()
          };
        });

        setMappings(prev => {
          const next = [...prev];
          updates.forEach(u => {
            const existingIdx = next.findIndex(m => m.originalId === u.originalId && m.type === activeTab);
            if (existingIdx !== -1) {
              next[existingIdx] = { ...next[existingIdx], order: u.order } as any;
            } else {
              next.push(u as any);
            }
          });
          return next;
        });

        await api.mappings.batchUpdate(updates as any[]);
      } catch (error) {
        console.error('Failed to update stream order:', error);
        refreshMappings();
      }
    }
  };

  const sortedStreams = useMemo(() => {
    if (!streams.length) return [];
    
    // Create a lookup map for better performance
    const mappingByOriginalId = new Map();
    mappings.forEach(m => {
      if (m.type === activeTab) {
        mappingByOriginalId.set(m.originalId, m);
      }
    });

    const streamsWithOrder = streams.map((s, idx) => {
      const originalId = (s.stream_id || s.series_id || `idx-${idx}`).toString();
      const mapping = originalId ? mappingByOriginalId.get(originalId) : null;
      return { ...s, _uniqueId: originalId, order: mapping ? (mapping.order ?? 999999) : 999999 };
    });
    return streamsWithOrder.sort((a, b) => a.order - b.order);
  }, [streams, mappings, activeTab]);

  const sortedCategories = useMemo(() => {
    if (!categories.length) return [];
    
    const mappingByOriginalId = new Map();
    categoryMappings.forEach(m => {
      if (m.type === activeTab) {
        mappingByOriginalId.set(m.originalId, m);
      }
    });

    const categoriesWithOrder = (categories || []).map((c) => {
      const catId = String(c.category_id || c.id);
      const mapping = mappingByOriginalId.get(catId);
      return { ...c, order: mapping ? (mapping.order ?? 999999) : 999999 };
    });
    
    const sorted = categoriesWithOrder.sort((a, b) => a.order - b.order);
    if (!categorySearch.trim()) return sorted;
    const q = categorySearch.toLowerCase();
    return sorted.filter(c => (c.category_name || c.name || '').toLowerCase().includes(q));
  }, [categories, categoryMappings, activeTab, categorySearch]);

  const filteredStreams = useMemo(() => {
    if (selectedCategoryIds.size === 0) return [];
    
    const searchLower = searchTerm.toLowerCase();
    
    return sortedStreams.filter(s => {
      // Fast path: bypass string allocations and checks if category doesn't match
      if (!selectedCategoryIds.has(String(s.category_id))) return false;
      
      if (!searchLower) return true;
      return (s.name || s.title || "").toLowerCase().includes(searchLower);
    });
  }, [sortedStreams, searchTerm, selectedCategoryIds]);

  const [showSourceSelector, setShowSourceSelector] = useState(false);
  const [allSources, setAllSources] = useState<UpstreamSource[]>([]);

  useEffect(() => {
    api.sources.list().then(setAllSources).catch(console.error);
  }, []);

  const toggleSource = async (sourceId: string) => {
    if (!playlist || !id) return;
    try {
      const newSourceIds = playlist.sourceIds.includes(sourceId)
        ? playlist.sourceIds.filter(sid => sid !== sourceId)
        : [...playlist.sourceIds, sourceId];
      await api.playlists.update(id, { sourceIds: newSourceIds });
      loadPlaylistData();
    } catch (error) {
      console.error('Failed to update playlist sources:', error);
    }
  };

  const applyRegex = (name: string, rules: { pattern: string; replacement: string }[] = []) => {
    let newName = name;
    rules.forEach(rule => {
      try {
        const re = new RegExp(rule.pattern, 'g');
        newName = newName.replace(re, rule.replacement);
      } catch (e) {
        // Invalid regex
      }
    });
    return newName;
  };

  const handleBatchApplyRegex = async (rules: { pattern: string; replacement: string }[], scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];
    
    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }

    if (activeStreams.length === 0) {
      alert("No channels selected in scope.");
      return;
    }

    const mappingLookup = new Map(mappings.filter(m => m.type === activeTab).map(m => [m.originalId, m]));

    const updates = activeStreams.map(stream => {
      const sid = String(stream._uniqueId);
      const existingMapping = mappingLookup.get(sid);
      const originalName = stream.name || stream.title || "";
      let newName = existingMapping?.customName || originalName;
      const initialName = newName;
      
      rules.forEach(rule => {
        try {
          if (!rule.pattern) return;
          const re = new RegExp(rule.pattern, 'g');
          newName = newName.replace(re, rule.replacement);
        } catch(e) {}
      });

      if (newName === initialName) return null;

      return {
        id: existingMapping?.id,
        originalId: sid,
        playlistId: id,
        type: activeTab,
        customName: newName
      };
    }).filter(Boolean);

    if (updates.length > 0) {
      try {
        setLoading(true);
        await api.mappings.batchUpdate(updates as any[]);
        await refreshMappings();
      } catch (error) {
        console.error("Batch update failed:", error);
        alert("Failed to apply batch changes.");
      } finally {
        setLoading(false);
      }
    } else {
      alert("No changes to apply.");
    }
  };

  const handleBatchVisibility = async (hidden: boolean, scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];
    
    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }

    if (activeStreams.length === 0) {
      alert("No channels selected in scope.");
      return;
    }

    const mappingLookup = new Map(mappings.filter(m => m.type === activeTab).map(m => [m.originalId, m]));

    const updates = activeStreams.map(stream => {
      const sid = String(stream._uniqueId);
      const existingMapping = mappingLookup.get(sid);
      
      if (existingMapping && existingMapping.hidden === hidden) return null;
      if (!existingMapping && !hidden) return null; // Already visible by default

      return {
        id: existingMapping?.id,
        originalId: sid,
        playlistId: id,
        type: activeTab,
        hidden
      };
    }).filter(Boolean);

    if (updates.length > 0) {
      try {
        setLoading(true);
        await api.mappings.batchUpdate(updates as any[]);
        await refreshMappings();
      } catch (error) {
        console.error("Batch visibility update failed:", error);
        alert("Failed to apply batch changes.");
      } finally {
        setLoading(false);
      }
    } else {
      alert("No changes to apply.");
    }
  };

  const handleBatchMove = async (newCategoryId: string, scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];
    
    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }

    if (activeStreams.length === 0) {
      alert("No channels selected in scope.");
      return;
    }

    const mappingLookup = new Map(mappings.filter(m => m.type === activeTab).map(m => [m.originalId, m]));

    const updates = activeStreams.map(stream => {
      const sid = String(stream._uniqueId);
      const existingMapping = mappingLookup.get(sid);
      
      if (existingMapping && existingMapping.categoryId === newCategoryId) return null;
      if (!existingMapping && String(stream.category_id) === newCategoryId) return null;
      
      return {
        id: existingMapping?.id,
        originalId: sid,
        playlistId: id,
        type: activeTab,
        categoryId: newCategoryId
      };
    }).filter(Boolean);

    if (updates.length > 0) {
      try {
        setLoading(true);
        await api.mappings.batchUpdate(updates as any[]);
        await refreshMappings();
        alert(`Successfully moved ${updates.length} items.`);
      } catch (error) {
        console.error("Batch move failed:", error);
        alert("Failed to apply batch changes.");
      } finally {
        setLoading(false);
      }
    } else {
      alert("No changes to apply.");
    }
  };


  const handleAutoMatchEpg = async () => {
    if (!id) return;
    try {
      const { channels } = await api.epgs.channels(id);
      if (!channels.length) { alert('No EPG channels available. Enable "Use Upstream EPG" on a source or add custom EPG sources.'); return; }

      const normalize = (s: string) =>
        s.toLowerCase().replace(/\b(hd|fhd|4k|sd|uhd|the|le|la|les|das|der|die)\b/gi, '').replace(/[^a-z0-9]/g, '').trim();

      // Streams without any EPG mapping
      const streamsToMatch = filteredStreams.filter(s => {
        const m = mappings.find(mp => mp.originalId === String(s._uniqueId));
        return !m?.epgMapping;
      });

      // Streams already mapped but missing epgIcon (icon was not saved when matched)
      const streamsToUpdateIcon = filteredStreams.filter(s => {
        const m = mappings.find(mp => mp.originalId === String(s._uniqueId));
        return m?.epgMapping && !m?.epgIcon;
      });

      const updates: any[] = [];

      // Full name-based auto-match for unmatched streams
      for (const stream of streamsToMatch) {
        const target = normalize(stream.name || stream.title || '');
        if (!target) continue;
        let best: { id: string; name: string; icon?: string; source?: string } | null = null;
        let bestScore = 0;
        for (const ch of channels) {
          const n = normalize(ch.name);
          if (n === target) { best = ch; bestScore = 3; break; }
          const score = (n.startsWith(target) || target.startsWith(n)) ? 2 : (n.includes(target) || target.includes(n)) ? 1 : 0;
          if (score > bestScore) { best = ch; bestScore = score; }
        }
        if (!best || bestScore === 0) continue;
        const existing = mappings.find(mp => mp.originalId === String(stream._uniqueId));
        updates.push(existing?.id
          ? { id: existing.id, epgMapping: best.id, epgIcon: best.icon || '', epgSource: best.source || '' }
          : { playlistId: id, type: activeTab === 'vod' ? 'vod' : activeTab, originalId: String(stream._uniqueId), originalName: stream.name || stream.title || '', customName: stream.name || stream.title || '', order: 0, hidden: false, categoryId: String(stream.category_id || ''), epgMapping: best.id, epgIcon: best.icon || '', epgSource: best.source || '' }
        );
      }

      // Icon-only update for already-matched streams that are missing their icon
      for (const stream of streamsToUpdateIcon) {
        const existing = mappings.find(mp => mp.originalId === String(stream._uniqueId));
        if (!existing?.id || !existing.epgMapping) continue;
        const ch = channels.find(c => c.id === existing.epgMapping);
        if (ch?.icon || ch?.source) {
          updates.push({ id: existing.id, epgIcon: ch?.icon || '', epgSource: ch?.source || '' });
        }
      }

      if (!updates.length) { alert('All streams are already matched and have icons.'); return; }
      await api.mappings.batchUpdate(updates);
      await refreshMappings();
      const iconUpdates = updates.filter(u => !u.epgMapping).length;
      const newMatches = updates.length - iconUpdates;
      const parts = [];
      if (newMatches > 0) parts.push(`matched ${newMatches} stream${newMatches === 1 ? '' : 's'}`);
      if (iconUpdates > 0) parts.push(`updated icons for ${iconUpdates} stream${iconUpdates === 1 ? '' : 's'}`);
      alert(`Auto-match: ${parts.join(', ')}.`);
    } catch (e) {
      console.error('Auto-match EPG failed:', e);
      alert('Auto-match failed.');
    }
  };

  const refreshMappings = useCallback(async () => {
    if (!id) return;
    const [mappingData, catMappingData] = await Promise.all([
      api.mappings.list(id),
      api.categoryMappings.list(id),
    ]);
    setMappings(mappingData);
    setCategoryMappings(catMappingData);
  }, [id]);

  const isPlaylistLoading = !playlist;

  const handleStreamClick = (stream: any, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const streamId = stream._uniqueId;
    if (!streamId) return;
    
    const visibleStreamIds = filteredStreams.map(s => String(s._uniqueId));
    
    setSelectedStreamIds(prev => {
      const newSet = new Set(prev);
      if (e.metaKey || e.ctrlKey) {
        if (newSet.has(streamId)) newSet.delete(streamId);
        else newSet.add(streamId);
        setLastSelectedStreamId(streamId);
      } else if (e.shiftKey && lastSelectedStreamId) {
        const startIdx = visibleStreamIds.indexOf(lastSelectedStreamId);
        const endIdx = visibleStreamIds.indexOf(streamId);
        if (startIdx !== -1 && endIdx !== -1) {
          const start = Math.min(startIdx, endIdx);
          const end = Math.max(startIdx, endIdx);
          visibleStreamIds.slice(start, end + 1).forEach(id => newSet.add(id));
        }
      } else {
        newSet.clear();
        newSet.add(streamId);
        setLastSelectedStreamId(streamId);
      }
      return newSet;
    });
  };

  const handleCategoryClick = (catId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedStreamIds(new Set()); // clear stream selection when switching to category
    const visibleCategories = (sortedCategories || []).map(c => String(c.category_id || c.id));
    
    setSelectedCategoryIds(prev => {
      const newSet = new Set(prev);
      if (e.metaKey || e.ctrlKey) {
        if (newSet.has(catId)) newSet.delete(catId);
        else newSet.add(catId);
        setLastSelectedCategoryId(catId);
      } else if (e.shiftKey && lastSelectedCategoryId) {
        const startIdx = visibleCategories.indexOf(lastSelectedCategoryId);
        const endIdx = visibleCategories.indexOf(catId);
        if (startIdx !== -1 && endIdx !== -1) {
          const start = Math.min(startIdx, endIdx);
          const end = Math.max(startIdx, endIdx);
          visibleCategories.slice(start, end + 1).forEach(id => newSet.add(id));
        }
      } else {
        newSet.clear();
        newSet.add(catId);
        setLastSelectedCategoryId(catId);
      }
      return newSet;
    });
  };

  const handleCategoryBatchVisibility = async (hidden: boolean) => {
    if (selectedCategoryIds.size === 0) return;
    try {
      setLoading(true);
      const updates = Array.from(selectedCategoryIds).map(catId => {
        const mapping = categoryMappings.find(m => m.originalId === catId && m.type === activeTab);
        return {
          id: mapping?.id,
          originalId: catId,
          playlistId: id,
          type: activeTab,
          hidden
        };
      });
      await api.categoryMappings.batchUpdate(updates);
      await refreshMappings();
    } catch (error) {
      console.error("Batch visibility update failed:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 select-none">
      {isPlaylistLoading ? (
        <div className="p-8 flex items-center justify-center h-full">
          <div className="flex items-center gap-2 text-zinc-500 animate-pulse">
            <RefreshCw size={20} className="animate-spin" />
            Loading playlist...
          </div>
        </div>
      ) : (
        <>


      {showSourceSelector && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full space-y-6"
          >
            <h3 className="text-2xl font-bold">Select Upstream Sources</h3>
            <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
              {allSources.map(source => (
                <label key={source.id} className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-2xl cursor-pointer hover:border-emerald-500/50 transition-all">
                  <div className="flex items-center gap-3">
                    <div className={clsx("w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all", playlist.sourceIds.includes(source.id) ? "bg-emerald-500 border-emerald-500" : "border-zinc-800")}>
                      {playlist.sourceIds.includes(source.id) && <RefreshCw size={12} className="text-zinc-950" />}
                    </div>
                    <span className="font-medium">{source.name}</span>
                  </div>
                  <input 
                    type="checkbox" 
                    className="hidden" 
                    checked={playlist.sourceIds.includes(source.id)} 
                    onChange={() => toggleSource(source.id)}
                  />
                </label>
              ))}

              {playlist.sourceIds.filter(id => !allSources.find(s => s.id === id)).map(missingId => (
                <label key={missingId} className="flex items-center justify-between p-4 bg-red-500/5 border border-red-500/20 rounded-2xl cursor-pointer hover:border-red-500/50 transition-all group">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-md border-2 bg-red-500 border-red-500 flex items-center justify-center">
                      <X size={12} className="text-zinc-950" />
                    </div>
                    <div>
                      <span className="font-medium text-red-400">Deleted Source</span>
                      <p className="text-[10px] text-zinc-600 font-mono tracking-tighter truncate w-32">{missingId}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => toggleSource(missingId)}
                    className="p-2 bg-red-500/10 text-red-500 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Unlink
                  </button>
                </label>
              ))}
            </div>
            <button 
              onClick={() => setShowSourceSelector(false)}
              className="w-full py-3 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all"
            >
              Done
            </button>
          </motion.div>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10 px-4">
        <div className="flex items-center">
          <Link to="/" className="p-2 hover:bg-zinc-800 rounded-xl text-zinc-400 mr-2 -ml-2">
            <ArrowLeft size={18} />
          </Link>
          <h2 className="text-base font-bold tracking-tight mr-4">{playlist.name}</h2>
          
          <div className="h-6 w-px bg-zinc-800 mr-2" />
          
          <TabButton active={activeTab === 'live'} onClick={() => setActiveTab('live')} label="TV Channels" />
          <TabButton active={activeTab === 'vod'} onClick={() => setActiveTab('vod')} label="Movies" />
          <TabButton active={activeTab === 'series'} onClick={() => setActiveTab('series')} label="Series" />
        </div>
        
        <div className="flex gap-2 items-center">
          <button
            onClick={() => setShowSourceSelector(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-zinc-800 text-zinc-300 rounded-lg font-bold hover:bg-zinc-700 hover:text-white transition-all"
          >
            <Database size={14} />
            Sources ({playlist.sourceIds.length})
          </button>
          <button 
            onClick={() => loadData(true)}
            className="p-1.5 bg-zinc-800 text-zinc-400 hover:text-zinc-100 rounded-lg transition-all flex items-center justify-center"
            title={lastUpdated ? `Last updated: ${new Date(lastUpdated).toLocaleString()}` : 'Refresh'}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {isCached && !loading && <span className="ml-[2px] text-[9px] uppercase font-bold text-zinc-500">Cached</span>}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden flex-col relative">
        <div className="flex-1 flex overflow-hidden relative">
          {/* Categories Sidebar */}
        <aside className="w-80 border-r border-zinc-800 flex flex-col bg-zinc-900/20 shrink-0">
          <div className="p-4 border-b border-zinc-800">
            <div className="flex gap-2 mb-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" size={16} />
                <input
                  value={categorySearch}
                  onChange={e => setCategorySearch(e.target.value)}
                  placeholder="Search categories..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm focus:border-emerald-500 outline-none"
                />
              </div>
              {selectedCategoryIds.size > 0 && (
                <button 
                  onClick={() => handleBatchMoveToTop('categories')}
                  className="px-3 py-2 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-xl text-[10px] font-bold hover:bg-emerald-500/20 transition-all shrink-0"
                  title="Move selected to top"
                >
                  <ChevronRight className="-rotate-90" size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <DndContext 
              sensors={sensors} 
              collisionDetection={closestCenter} 
              onDragStart={handleCategoryDragStart}
              onDragEnd={handleCategoryDragEnd}
            >
              <SortableContext items={(sortedCategories || []).map(c => String(c.category_id || c.id))} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {(sortedCategories || []).map(cat => {
                    const catId = String(cat.category_id || cat.id);
                    const mapping = categoryMappings.find(m => m.originalId === catId && m.type === activeTab);
                    return (
                      <SortableCategory 
                        key={catId} 
                        cat={cat} 
                        mapping={mapping}
                        activeTab={activeTab}
                        playlistId={id || ""}
                        onMappingChange={refreshMappings}
                        onBatchVisibilityToggle={handleCategoryBatchVisibility}
                        isSelected={selectedCategoryIds.has(catId)}
                        onClick={(e) => handleCategoryClick(catId, e)}
                      />
                    );
                  })}
                </div>
              </SortableContext>
              <DragOverlay>
                {activeCategoryId ? (
                  <div className="bg-zinc-900 border border-emerald-500/50 shadow-2xl rounded-xl px-4 py-3 text-sm font-bold flex items-center justify-between gap-4 text-emerald-400">
                    <div className="flex items-center gap-2">
                      <Edit3 size={16} />
                      <span>Moving {selectedCategoryIds.has(activeCategoryId) ? selectedCategoryIds.size : 1} {selectedCategoryIds.size === 1 || !selectedCategoryIds.has(activeCategoryId) ? 'category' : 'categories'}</span>
                    </div>
                    <GripVertical size={14} className="opacity-50" />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        </aside>

        {/* Streams Grid */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {!loading && !sources.length ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 p-8">
              <div className="p-6 bg-zinc-900 rounded-full text-zinc-700">
                <Database size={48} />
              </div>
              <div className="space-y-1">
                <h3 className="text-xl font-bold">No sources linked</h3>
                <p className="text-zinc-500 max-w-xs">Click the "Sources" button above to link an upstream provider to this playlist.</p>
              </div>
              <button
                onClick={() => setShowSourceSelector(true)}
                className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-400 transition-all"
              >
                <Database size={18} />
                Link a Source
              </button>
            </div>
          ) : (
          <>
            <div className="p-3 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/10">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" size={16} />
                <input 
                  placeholder={`Search ${activeTab}...`} 
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm focus:border-emerald-500 outline-none"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleAutoMatchEpg}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors whitespace-nowrap"
                  title="Auto-match EPG channels by name for all unmatched streams"
                >
                  <Tv size={12} />
                  Auto-match EPG
                </button>
                <div className="text-xs text-zinc-500 font-mono italic">
                  {`${filteredStreams.length.toLocaleString()} of ${streams.length.toLocaleString()} items`}
                </div>
              </div>
            </div>

            {/* Table header */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/30 text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
              <div className="w-8 shrink-0"></div>
              <div className="w-10 shrink-0 text-center">#</div>
              <div className="flex-1 min-w-0">Name</div>
              <div className="w-20 shrink-0 text-center">Actions</div>
            </div>

            {/* Stream list + Editor pane side by side */}
            <div className="flex-1 flex flex-row min-h-0">
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <StreamTable
                  streams={filteredStreams}
                  selectedCategoryIds={selectedCategoryIds}
                  activeTab={activeTab}
                  mappings={mappings}
                  playlistId={id!}
                  applyRegex={applyRegex}
                  onMappingChange={refreshMappings}
                  onDragEnd={handleStreamDragEnd}
                  loading={loading}
                  onSelectStream={handleStreamClick}
                  selectedStreamIds={selectedStreamIds}
                  epgChannels={epgChannels}
                  playlist={playlist}
                  globalFormat={globalFormat}
                />
              </div>

              {selectedStreamIds.size >= 1 && (() => {
                const firstId = Array.from(selectedStreamIds)[0];
                const firstStream = sortedStreams.find((s: any) => s._uniqueId === firstId || String(s.stream_id) === firstId);
                if (!firstStream) return null;
                const firstMapping = mappings.find(m => m.originalId === firstId && m.type === activeTab);
                return (
                  <EditorPane
                    key={firstId}
                    stream={firstStream}
                    mapping={firstMapping}
                    playlistId={id!}
                    type={activeTab}
                    source={sources[0]}
                    playlist={playlist}
                    globalFormat={globalFormat}
                    onClose={() => setSelectedStreamIds(new Set())}
                    onUpdate={refreshMappings}
                    selectedStreamIds={selectedStreamIds.size > 1 ? selectedStreamIds : undefined}
                    allStreams={selectedStreamIds.size > 1 ? sortedStreams : undefined}
                    allMappings={selectedStreamIds.size > 1 ? mappings : undefined}
                    onBatchApply={selectedStreamIds.size > 1 ? (rules) => handleBatchApplyRegex(rules, 'streams') : undefined}
                    onBatchVisibility={selectedStreamIds.size > 1 ? (hidden) => handleBatchVisibility(hidden, 'streams') : undefined}
                    onBatchMoveToTop={selectedStreamIds.size > 1 ? () => handleBatchMoveToTop('streams') : undefined}
                  />
                );
              })()}

              {selectedStreamIds.size === 0 && selectedCategoryIds.size > 0 && (
                <CategoryPane
                  selectedCategoryIds={selectedCategoryIds}
                  categories={categories}
                  categoryMappings={categoryMappings}
                  playlistId={id!}
                  activeTab={activeTab}
                  sortedStreams={sortedStreams}
                  mappings={mappings}
                  playlist={playlist}
                  onClose={() => setSelectedCategoryIds(new Set())}
                  onMappingChange={refreshMappings}
                  onBatchVisibility={(hidden) => handleCategoryBatchVisibility(hidden)}
                  onMoveToTop={() => handleBatchMoveToTop('categories')}
                  onBatchApplyRegex={(rules) => handleBatchApplyRegex(rules, 'categories')}
                  onBatchStreamVisibility={(hidden) => handleBatchVisibility(hidden, 'categories')}
                  onMoveStreamsToTop={() => handleBatchMoveToTop('streams')}
                />
              )}
            </div>
          </>
          )}
        </div>
        </div>
        </div>
      </>
      )}
    </div>
  );
}

interface BatchActionsSectionProps {
  streamIds: string[];
  playlistId: string;
  activeTab: 'live' | 'vod' | 'series';
  mappings: StreamMapping[];
  playlist: Playlist | null;
  onRefresh: () => void;
  onBatchApply: (rules: { pattern: string; replacement: string }[]) => void;
  onBatchVisibility: (hidden: boolean) => void;
  onBatchMoveToTop: () => void;
}

function BatchActionsSection({
  streamIds,
  playlistId,
  activeTab,
  mappings,
  playlist,
  onRefresh,
  onBatchApply,
  onBatchVisibility,
  onBatchMoveToTop,
}: BatchActionsSectionProps) {
  const [rules, setRules] = useState([{ pattern: '', replacement: '' }]);

  // Quality scan state
  const [scanConcurrency, setScanConcurrency] = useState(1);
  const [skipScanned, setSkipScanned] = useState(true);
  const [scanJobId, setScanJobId] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<{ status: string; total: number; done: number; failed: number } | null>(null);
  const [scanPolling, setScanPolling] = useState(false);

  const mappingsById = useMemo(() => {
    const map = new Map<string, StreamMapping>();
    mappings.forEach(m => { if (m.type === activeTab) map.set(m.originalId, m); });
    return map;
  }, [mappings, activeTab]);

  async function startScan() {
    if (!playlist) return;
    const ids = skipScanned
      ? streamIds.filter(id => !mappingsById.get(id)?.detectedMeta)
      : streamIds;
    if (!ids.length) return;
    const { jobId } = await api.qualityScan.start({
      playlistId,
      streamIds: ids,
      type: activeTab,
      concurrency: scanConcurrency,
    });
    setScanJobId(jobId);
    setScanJob({ status: 'running', total: ids.length, done: 0, failed: 0 });
    setScanPolling(true);
  }

  useEffect(() => {
    if (!scanPolling || !scanJobId) return;
    const interval = setInterval(async () => {
      try {
        const job = await api.qualityScan.status(scanJobId);
        setScanJob(job);
        if (job.status !== 'running') {
          setScanPolling(false);
          clearInterval(interval);
          onRefresh();
        }
      } catch (e) {
        console.error('[QualityScan] polling error:', e);
        setScanPolling(false);
        clearInterval(interval);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [scanPolling, scanJobId, onRefresh]);

  async function cancelScan() {
    if (scanJobId) await api.qualityScan.cancel(scanJobId);
    setScanPolling(false);
  }

  const scanableCount = useMemo(() => {
    if (!skipScanned) return streamIds.length;
    return streamIds.filter(id => !mappingsById.get(id)?.detectedMeta).length;
  }, [streamIds, skipScanned, mappingsById]);

  // Quality Label Toggle
  const withMeta = streamIds.filter(id => mappingsById.get(id)?.detectedMeta?.resolution);
  const allOn = withMeta.length > 0 && withMeta.every(id => mappingsById.get(id)?.useDetectedQuality);
  const allOff = withMeta.length > 0 && withMeta.every(id => !mappingsById.get(id)?.useDetectedQuality);
  const indeterminate = withMeta.length > 0 && !allOn && !allOff;

  async function toggleAll(enable: boolean) {
    if (!withMeta.length) return;
    const updates = withMeta
      .map(id => mappingsById.get(id))
      .filter((m): m is StreamMapping => !!m?.id)
      .map(m => ({ id: m.id, useDetectedQuality: enable }));
    if (!updates.length) return;
    await api.mappings.batchUpdate(updates);
    onRefresh();
  }

  return (
    <div className="space-y-6">
      {/* Quality Label Toggle Section */}
      <div className="space-y-3 border-b border-zinc-800 pb-4">
        <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">
          Quality Label
        </div>
        {withMeta.length === 0 ? (
          <p className="text-[10px] text-zinc-600 italic">No scanned channels in selection</p>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-zinc-500">{withMeta.length} scanned channel{withMeta.length !== 1 ? 's' : ''}</p>
            <div className="flex gap-2">
              <button
                onClick={() => toggleAll(true)}
                disabled={allOn}
                className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {indeterminate ? 'Enable all' : 'Enable'}
              </button>
              <button
                onClick={() => toggleAll(false)}
                disabled={allOff}
                className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Disable all
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Regex Rename Section */}
      <div className="space-y-3">
        <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
          <Edit3 size={12} /> Regex Rename
        </div>
        <div className="bg-zinc-950/50 border border-zinc-800 rounded-2xl p-3 space-y-2">
          {rules.map((rule, idx) => (
            <div key={idx} className="flex gap-2">
              <input
                value={rule.pattern}
                onChange={e => { const r = [...rules]; r[idx].pattern = e.target.value; setRules(r); }}
                className="w-1/2 bg-zinc-900 border border-zinc-800/80 rounded-lg px-3 py-2 text-xs text-emerald-400 focus:border-emerald-500 outline-none font-mono placeholder:text-zinc-600 transition-colors"
                placeholder="Pattern"
              />
              <input
                value={rule.replacement}
                onChange={e => { const r = [...rules]; r[idx].replacement = e.target.value; setRules(r); }}
                className="w-1/2 bg-zinc-900 border border-zinc-800/80 rounded-lg px-3 py-2 text-xs text-blue-400 focus:border-emerald-500 outline-none font-mono placeholder:text-zinc-600 transition-colors"
                placeholder="Replacement"
              />
              <button
                onClick={() => setRules(rules.filter((_, i) => i !== idx))}
                className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                title="Remove Rule"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="pt-2 flex justify-between items-center">
            <button
              onClick={() => setRules([...rules, { pattern: '', replacement: '' }])}
              className="text-[10px] font-bold text-zinc-500 hover:text-emerald-500 transition-colors uppercase tracking-wider px-2 py-1 hover:bg-emerald-500/10 rounded-md"
            >
              + Add Rule
            </button>
            <button
              onClick={() => onBatchApply(rules)}
              className="px-4 py-1.5 bg-emerald-500 text-zinc-950 font-black rounded-lg text-[10px] hover:bg-emerald-400 transition-all uppercase tracking-tighter"
            >
              Apply Regex rename
            </button>
          </div>
        </div>
      </div>

      <div className="h-px w-full bg-zinc-800/50" />

      {/* Quality Scan Section */}
      <div className="space-y-3">
        <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
          <Search size={12} /> Quality Scan
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-400">Concurrency</span>
            <select
              value={scanConcurrency}
              onChange={e => setScanConcurrency(Number(e.target.value))}
              disabled={scanPolling}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-emerald-500 transition-colors disabled:opacity-50"
            >
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={skipScanned}
              onChange={e => setSkipScanned(e.target.checked)}
              disabled={scanPolling}
              className="accent-emerald-500"
            />
            Skip already scanned
          </label>
          {scanJob && (
            <div className="space-y-1.5">
              <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                  style={{ width: `${scanJob.total ? (scanJob.done / scanJob.total) * 100 : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                <span>{scanJob.done} / {scanJob.total} done</span>
                {scanJob.failed > 0 && <span className="text-red-400">{scanJob.failed} failed</span>}
                <span className="capitalize">{scanJob.status}</span>
              </div>
            </div>
          )}
          {!scanPolling ? (
            <button
              onClick={startScan}
              disabled={scanableCount === 0 || !playlist}
              className="w-full flex justify-center items-center gap-2 px-4 py-2.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-xl text-xs font-bold hover:bg-blue-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:-translate-y-0.5"
            >
              <Search size={14} />
              Scan {scanableCount} channel{scanableCount !== 1 ? 's' : ''}
            </button>
          ) : (
            <button
              onClick={cancelScan}
              className="w-full flex justify-center items-center gap-2 px-4 py-2.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-xs font-bold hover:bg-red-500/20 transition-all hover:-translate-y-0.5"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="h-px w-full bg-zinc-800/50" />

      {/* Visibility Actions */}
      <div className="space-y-3">
        <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
          <Eye size={12} /> Visibility
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onBatchVisibility(false)}
            className="flex justify-center items-center gap-2 px-4 py-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-xl text-xs font-bold hover:bg-emerald-500/20 transition-all hover:-translate-y-0.5"
          >
            <Eye size={14} />
            Show All
          </button>
          <button
            onClick={() => onBatchVisibility(true)}
            className="flex justify-center items-center gap-2 px-4 py-2.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-xs font-bold hover:bg-red-500/20 transition-all hover:-translate-y-0.5"
          >
            <EyeOff size={14} />
            Hide All
          </button>
        </div>
      </div>

      <div className="h-px w-full bg-zinc-800/50" />

      {/* Move to Top */}
      <div className="space-y-3">
        <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
          <ArrowLeft className="rotate-90" size={12} /> Order
        </div>
        <button
          onClick={onBatchMoveToTop}
          disabled={streamIds.length === 0}
          className="w-full flex justify-center items-center gap-2 px-4 py-2.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-xl text-xs font-bold hover:bg-blue-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:-translate-y-0.5"
        >
          <ArrowLeft size={14} className="rotate-90" />
          Move to Top
        </button>
      </div>
    </div>
  );
}

interface CategoryPaneProps {
  selectedCategoryIds: Set<string>;
  categories: any[];               // upstream category objects with category_id, name
  categoryMappings: CategoryMapping[];
  playlistId: string;
  activeTab: 'live' | 'vod' | 'series';
  sortedStreams: any[];             // all streams (to compute which belong to selected categories)
  mappings: StreamMapping[];
  playlist: Playlist | null;
  onClose: () => void;
  onMappingChange: () => void;     // refresh after changes
  onBatchVisibility: (hidden: boolean) => void;   // for category-level hide/show
  onMoveToTop: () => void;                         // move selected categories to top
  onBatchApplyRegex: (rules: { pattern: string; replacement: string }[]) => void;
  onBatchStreamVisibility: (hidden: boolean) => void;  // for streams within categories
  onMoveStreamsToTop: () => void;
}

function CategoryPane({
  selectedCategoryIds, categories, categoryMappings, playlistId, activeTab,
  sortedStreams, mappings, playlist, onClose, onMappingChange,
  onBatchVisibility, onMoveToTop, onBatchApplyRegex, onBatchStreamVisibility, onMoveStreamsToTop,
}: CategoryPaneProps) {
  const isSingle = selectedCategoryIds.size === 1;
  const catId = isSingle ? Array.from(selectedCategoryIds)[0] : null;

  const category = catId ? categories.find(c => String(c.category_id) === catId) : null;
  const mapping = catId ? categoryMappings.find(m => String(m.originalId) === catId) : null;

  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Sync nameVal when selection changes
  useEffect(() => {
    setNameVal(mapping?.customName || category?.name || '');
    setEditingName(false);
  }, [catId, mapping?.customName, category?.name]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  const handleRename = async () => {
    if (!catId) return;
    const trimmed = nameVal.trim();
    if (!trimmed) return;
    if (mapping?.id) {
      await api.categoryMappings.update(mapping.id, { customName: trimmed });
    } else {
      await api.categoryMappings.create({ playlistId, type: activeTab, originalId: catId, originalName: category?.name || '', customName: trimmed, order: 0, hidden: false });
    }
    setEditingName(false);
    onMappingChange();
  };

  const handleToggleVisible = async () => {
    if (!catId) return;
    const newHidden = !(mapping?.hidden ?? false);
    if (mapping?.id) {
      await api.categoryMappings.update(mapping.id, { hidden: newHidden });
    } else {
      await api.categoryMappings.create({ playlistId, type: activeTab, originalId: catId, originalName: category?.name || '', customName: category?.name || '', order: 0, hidden: newHidden });
    }
    onMappingChange();
  };

  const handleToggleSync = async () => {
    if (!catId) return;
    const newSync = !(mapping?.syncOnDemand ?? false);
    if (mapping?.id) {
      await api.categoryMappings.update(mapping.id, { syncOnDemand: newSync });
    } else {
      await api.categoryMappings.create({ playlistId, type: activeTab, originalId: catId, originalName: category?.name || '', customName: category?.name || '', order: 0, hidden: false, syncOnDemand: newSync });
    }
    onMappingChange();
  };

  // Streams that belong to ANY selected category
  const scopedStreamIds = useMemo(
    () => sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id))).map(s => String(s.stream_id ?? s._uniqueId)),
    [sortedStreams, selectedCategoryIds]
  );

  const isHidden = mapping?.hidden ?? false;
  const isSynced = mapping?.syncOnDemand ?? false;
  const displayName = mapping?.customName || category?.name || '(unknown)';

  return (
    <div className="w-96 border-l border-zinc-800 flex flex-col overflow-hidden bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Folder size={14} className="text-zinc-400 shrink-0" />
          {isSingle ? (
            editingName ? (
              <input
                ref={nameInputRef}
                value={nameVal}
                onChange={e => setNameVal(e.target.value)}
                onBlur={handleRename}
                onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditingName(false); }}
                className="bg-zinc-800 text-white text-sm px-2 py-0.5 rounded outline-none border border-zinc-600 min-w-0 flex-1"
              />
            ) : (
              <span
                className="text-sm text-white font-medium truncate cursor-pointer hover:text-zinc-300"
                onClick={() => setEditingName(true)}
                title="Click to rename"
              >
                {displayName}
              </span>
            )
          ) : (
            <span className="text-sm text-white font-medium">{selectedCategoryIds.size} categories</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isSingle && (
            <>
              <button
                onClick={handleToggleVisible}
                className={`p-1.5 rounded hover:bg-zinc-800 transition-colors ${isHidden ? 'text-zinc-600' : 'text-zinc-300'}`}
                title={isHidden ? 'Show category' : 'Hide category'}
              >
                {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                onClick={handleToggleSync}
                className={`p-1.5 rounded hover:bg-zinc-800 transition-colors ${isSynced ? 'text-blue-400' : 'text-zinc-600'}`}
                title={isSynced ? 'Disable on-demand sync' : 'Enable on-demand sync'}
              >
                <Activity size={14} />
              </button>
            </>
          )}
          {!isSingle && (
            <>
              <button onClick={() => onBatchVisibility(false)} className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors">Show all</button>
              <button onClick={() => onBatchVisibility(true)} className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors">Hide all</button>
              <button onClick={onMoveToTop} className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors">Move to top</button>
            </>
          )}
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors ml-1">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Batch actions for streams in selected categories */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">
        {scopedStreamIds.length > 0 ? (
          <BatchActionsSection
            streamIds={scopedStreamIds}
            playlistId={playlistId}
            activeTab={activeTab}
            mappings={mappings}
            playlist={playlist}
            onRefresh={onMappingChange}
            onBatchApply={onBatchApplyRegex}
            onBatchVisibility={onBatchStreamVisibility}
            onBatchMoveToTop={onMoveStreamsToTop}
          />
        ) : (
          <div className="py-6 text-zinc-600 text-sm text-center">No streams in selected categories</div>
        )}
        </div>
      </div>
    </div>
  );
}

function SortableCategory({ cat, mapping, playlistId, activeTab, isSelected, onClick, onMappingChange, onBatchVisibilityToggle }: {
  cat: any; 
  mapping?: CategoryMapping;
  playlistId: string;
  activeTab: string;
  isSelected: boolean; 
  onClick: (e: React.MouseEvent) => void; 
  onMappingChange: () => void;
  onBatchVisibilityToggle?: (hidden: boolean) => void;
}) {
  const catId = String(cat.category_id || cat.id);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: catId });
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(mapping?.customName || cat.category_name || "");
  const style = { transform: CSS.Transform.toString(transform), transition };

  const toggleVisibility = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newHidden = !mapping?.hidden;
    
    if (isSelected && onBatchVisibilityToggle) {
      onBatchVisibilityToggle(newHidden);
      return;
    }

    try {
      if (mapping?.id) {
        await api.categoryMappings.update(mapping.id, { hidden: newHidden });
      } else {
        await api.categoryMappings.create({
          playlistId,
          type: activeTab,
          originalId: catId,
          originalName: cat.category_name || "",
          customName: cat.category_name || "",
          order: 0,
          hidden: newHidden
        });
      }
      onMappingChange();
    } catch (error) {
      console.error('Failed to toggle category visibility:', error);
    }
  };

  const handleRename = async () => {
    try {
      if (mapping?.id) {
        await api.categoryMappings.update(mapping.id, { customName: newName });
      } else {
        await api.categoryMappings.create({
          playlistId,
          type: activeTab,
          originalId: catId,
          originalName: cat.category_name || "",
          customName: newName,
          order: 0,
          hidden: false
        });
      }
      setIsEditing(false);
      onMappingChange();
    } catch (error) {
      console.error('Failed to rename category:', error);
    }
  };

  const toggleSyncOnDemand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newSync = !mapping?.syncOnDemand;
    
    try {
      if (mapping?.id) {
        await api.categoryMappings.update(mapping.id, { syncOnDemand: newSync });
      } else {
        await api.categoryMappings.create({
          playlistId,
          type: activeTab,
          originalId: catId,
          originalName: cat.category_name || "",
          customName: cat.category_name || "",
          order: 0,
          hidden: false,
          syncOnDemand: newSync
        });
      }
      onMappingChange();
    } catch (error) {
      console.error('Failed to toggle category sync on demand:', error);
    }
  };

  return (
    <div 
      ref={setNodeRef} 
      style={style}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-all group relative",
        isSelected 
          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.05)]" 
          : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300 border border-transparent",
        mapping?.hidden && "opacity-40 grayscale-[0.5]"
      )}
    >
      <button 
        {...attributes} 
        {...listeners}
        className={cn(
          "p-1 -ml-1 rounded transition-colors",
          isSelected ? "text-emerald-500/40 hover:text-emerald-500" : "text-zinc-600 hover:text-zinc-400 opacity-0 group-hover:opacity-100"
        )}
        onClick={e => e.stopPropagation()}
      >
        <GripVertical size={12} />
      </button>

      <div className="flex-1 flex items-center min-w-0">
        {isEditing ? (
          <form onSubmit={(e) => { e.preventDefault(); handleRename(); }} className="flex-1" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onBlur={() => setIsEditing(false)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-500"
            />
          </form>
        ) : (
          <div className="flex flex-col truncate">
            <span className={cn(
              "text-xs font-medium truncate transition-colors",
              isSelected ? "text-emerald-400" : "text-zinc-300 group-hover:text-zinc-100"
            )}>
              {mapping?.customName || cat.category_name}
            </span>
            {mapping?.syncOnDemand && (
              <span className="text-[8px] text-emerald-500/60 uppercase font-black flex items-center gap-0.5 mt-0.5">
                <Activity size={8} /> Dynamic Sync
              </span>
            )}
          </div>
        )}
      </div>

      <div className={cn(
        "flex items-center gap-1 transition-opacity",
        isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        <button 
          onClick={toggleSyncOnDemand}
          className={cn(
            "p-1 hover:bg-zinc-800 rounded transition-colors", 
            mapping?.syncOnDemand ? "text-emerald-500 hover:text-emerald-400" : "text-zinc-600 hover:text-zinc-400"
          )}
          title={mapping?.syncOnDemand ? "Disable Dynamic Name Sync" : "Enable Dynamic Name Sync (Updates on Player access)"}
        >
          <Activity size={12} />
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
          title="Rename"
        >
          <Edit2 size={12} />
        </button>
        <button 
          onClick={toggleVisibility}
          className={cn(
            "p-1 hover:bg-zinc-800 rounded transition-colors", 
            mapping?.hidden ? "text-zinc-500 hover:text-zinc-300" : "text-emerald-500 hover:text-emerald-400 transition-colors"
          )}
          title={mapping?.hidden ? "Show" : "Hide"}
        >
          {mapping?.hidden ? <EyeOff size={12} /> : <Eye size={12} className="fill-emerald-500/20" />}
        </button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button 
      onClick={onClick}
      className={clsx(
        "px-4 py-3 text-sm font-bold transition-all border-b-2",
        active ? "text-emerald-500 border-emerald-500 bg-emerald-500/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
      )}
    >
      {label}
    </button>
  );
}

function StreamTable({ streams, selectedCategoryIds, activeTab, mappings, playlistId, applyRegex, onMappingChange, onDragEnd, loading, onSelectStream, selectedStreamIds, epgChannels, playlist, globalFormat }: {
  streams: any[];
  selectedCategoryIds: Set<string>;
  activeTab: string;
  mappings: StreamMapping[];
  playlistId: string;
  applyRegex: (name: string, rules: { pattern: string; replacement: string }[]) => string;
  onMappingChange: () => void;
  onDragEnd: (event: any) => void;
  loading: boolean;
  onSelectStream: (stream: any, e: React.MouseEvent) => void;
  selectedStreamIds: Set<string>;
  epgChannels?: {id: string; name: string; icon?: string; source: string}[];
  playlist?: Playlist | null;
  globalFormat?: string;
}) {
  const filteredStreams = streams;

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo(0, 0);
    }
  }, [selectedCategoryIds]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [activeId, setActiveId] = useState<string | null>(null);

  const handleDragStart = (event: any) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event: any) => {
    setActiveId(null);
    onDragEnd(event);
  };

  const isDraggable = filteredStreams.length > 0 && filteredStreams.length < 2000;
  const streamIds = useMemo(() => isDraggable ? filteredStreams.map(s => s._uniqueId || "") : [], [filteredStreams, isDraggable]);

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 relative">
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <RefreshCw size={24} className="animate-spin text-zinc-600" />
        </div>
      ) : selectedCategoryIds.size === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm italic">
          Please select a category to view streams
        </div>
      ) : !filteredStreams.length ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm italic">
          No items found in this category
        </div>
      ) : (
        <div className="flex-1 min-h-0 bg-zinc-900/10">
          <AutoSizer renderProp={({ height, width }) => {
            const content = (
              <List
                height={height || 0}
                itemCount={filteredStreams.length}
                itemSize={58}
                width={width || 0}
                itemData={{
                  filteredStreams,
                  mappings,
                  activeTab,
                  playlistId,
                  applyRegex,
                  onMappingChange,
                  onSelectStream,
                  selectedStreamIds,
                  epgChannels,
                  playlist,
                  globalFormat,
                }}
              >
                {VirtualStreamRow}
              </List>
            );

            if (!isDraggable) return content;

            return (
              <DndContext 
                sensors={sensors} 
                collisionDetection={closestCenter} 
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={streamIds} strategy={verticalListSortingStrategy}>
                  {content}
                </SortableContext>
                <DragOverlay>
                  {activeId ? (
                    <div className="bg-zinc-900 border border-emerald-500/50 shadow-2xl rounded-xl px-4 py-3 text-sm font-bold flex items-center justify-between gap-4 text-emerald-400">
                      <div className="flex items-center gap-2">
                        <Edit3 size={16} />
                        <span>Moving {selectedStreamIds.has(activeId) ? selectedStreamIds.size : 1} {selectedStreamIds.size === 1 || !selectedStreamIds.has(activeId) ? 'item' : 'items'}</span>
                      </div>
                      <GripVertical size={14} className="opacity-50" />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            );
          }} />
        </div>
      )}
    </div>
  );
}

const VirtualStreamRow = React.memo(({ 
  index, 
  style, 
  data 
}: { 
  index: number; 
  style: React.CSSProperties; 
  data: any;
}) => {
  const {
    filteredStreams,
    mappings,
    activeTab,
    playlistId,
    applyRegex,
    onMappingChange,
    onSelectStream,
    selectedStreamIds,
    epgChannels,
    playlist,
    globalFormat,
  } = data;
  
  const stream = filteredStreams[index];
  const originalId = stream?._uniqueId || "fallback-id";
  const isSelected = selectedStreamIds.has(originalId);
  
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: originalId });

  if (!stream) return <div style={style} />;

  const mapping = mappings.find(m => m.originalId === originalId && m.type === activeTab);
  const originalName = stream.name || stream.title || "";
  const baseName = mapping
    ? computeDisplayName(mapping, playlist?.qualityLabelFormat, globalFormat, originalName)
    : originalName;
  const displayName = applyRegex(baseName, mapping?.regexRenames || []);
  
  const combinedStyle = {
    ...style,
    zIndex: isDragging ? 50 : 1,
    opacity: isDragging ? 0.7 : 1,
  };

  if (transform) {
    combinedStyle.transform = `${style.transform || ''} translate3d(${transform.x}px, ${transform.y}px, 0)`;
  }

  return (
    <StreamRowMemo
      ref={setNodeRef}
      style={combinedStyle}
      stream={stream}
      type={activeTab}
      mapping={mapping}
      playlistId={playlistId}
      displayName={displayName}
      originalName={originalName}
      originalId={originalId}
      index={index}
      onMappingChange={onMappingChange}
      onSelectStream={onSelectStream}
      dragAttributes={attributes}
      dragListeners={listeners}
      isDragging={isDragging}
      isSelected={isSelected}
      epgChannels={epgChannels}
    />
  );
});

const StreamRow = React.forwardRef<HTMLDivElement, {
  style: React.CSSProperties;
  stream: any;
  type: string;
  mapping?: StreamMapping;
  playlistId: string;
  displayName: string;
  originalName: string;
  originalId: string;
  index: number;
  onMappingChange: () => void;
  onSelectStream: (stream: any, e: React.MouseEvent) => void;
  dragAttributes?: any;
  dragListeners?: any;
  isDragging?: boolean;
  isSelected?: boolean;
  epgChannels?: {id: string; name: string; icon?: string; source: string}[];
}>(({ style, stream, type, mapping, playlistId, displayName, originalName, originalId, index, onMappingChange, onSelectStream, dragAttributes, dragListeners, isDragging, isSelected, epgChannels }, ref) => {
  const icon = mapping?.customIcon || mapping?.epgIcon || stream.stream_icon || stream.cover;
  const epgSource = mapping?.epgSource || (mapping?.epgMapping ? epgChannels?.find(c => c.id === mapping.epgMapping)?.source : undefined);

  const toggleVisibility = async () => {
    try {
      if (mapping?.id) {
        await api.mappings.update(mapping.id, { hidden: !mapping.hidden });
      } else {
        await api.mappings.create({
          playlistId,
          type,
          originalId,
          originalName,
          customName: originalName,
          order: 0,
          hidden: true,
          categoryId: String(stream.category_id || "")
        });
      }
      onMappingChange();
    } catch (error) {
      console.error('Failed to toggle visibility:', error);
    }
  };

  const handleRename = async (newName: string) => {
    try {
      if (mapping?.id) {
        await api.mappings.update(mapping.id, { customName: newName });
      } else {
        await api.mappings.create({
          playlistId,
          type,
          originalId,
          originalName,
          customName: newName,
          order: 0,
          hidden: false,
          categoryId: String(stream.category_id || "")
        });
      }
      onMappingChange();
    } catch (error) {
      console.error('Failed to rename stream:', error);
    }
  };

  return (
    <div
      ref={ref}
      style={style}
      onClick={(e) => onSelectStream(stream, e)}
      className={cn(
        "flex items-center gap-2 px-4 border-b border-zinc-800/50 transition-colors cursor-pointer group",
        mapping?.hidden && "opacity-40",
        isSelected 
          ? "bg-emerald-500/10" 
          : isDragging ? "bg-zinc-800" : (index % 2 === 0 ? "bg-zinc-950/30" : "bg-transparent"),
        !isDragging && !isSelected && "hover:bg-zinc-900/80"
      )}
    >
      <button 
        {...dragAttributes} 
        {...dragListeners} 
        className="text-zinc-700 hover:text-zinc-400 cursor-grab active:cursor-grabbing p-1"
        onClick={e => e.stopPropagation()}
      >
        <GripVertical size={14} />
      </button>

      {/* Icon */}
      <div className="w-8 h-7 shrink-0 rounded overflow-hidden bg-zinc-900 border border-zinc-800/50">
        {icon ? (
          <img src={icon} alt="" className="w-full h-full object-contain" referrerPolicy="no-referrer" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-800">
            <Tv size={12} />
          </div>
        )}
      </div>

      {/* ID */}
      <div className="w-10 shrink-0 text-center text-[10px] text-zinc-600 font-mono">
        {originalId}
      </div>

      {/* Name + EPG info */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
        <span className={cn(
          "text-sm truncate block",
          mapping?.customName && mapping.customName !== originalName
            ? "text-emerald-400"
            : "text-zinc-300"
        )}>
          {displayName}
        </span>
        {mapping?.epgMapping ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[10px] text-zinc-600 font-mono truncate">{mapping.epgMapping}</span>
            {epgSource && (() => { const c = epgSourceColor(epgSource); return (
              <span className="text-[9px] rounded px-1 py-px shrink-0 font-sans border" style={{ background: c.bg, borderColor: c.border, color: c.text }}>{epgSource}</span>
            ); })()}
          </div>
        ) : (
          <span className="text-[10px] text-zinc-700 italic">no epg</span>
        )}
      </div>

      {/* No more inline editor here */}

      {/* Actions */}
      <div className="w-20 shrink-0 flex justify-center gap-1">
        <button
          onClick={toggleVisibility}
          className={cn(
            "p-1 rounded transition-colors",
            mapping?.hidden
              ? "text-zinc-600 hover:text-zinc-300"
              : "text-emerald-500 hover:text-emerald-400"
          )}
          title={mapping?.hidden ? "Show" : "Hide"}
        >
          {mapping?.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
});

const StreamRowMemo = React.memo(StreamRow);

function EditorPane({ stream, mapping, playlistId, type, source, playlist, globalFormat, onClose, onUpdate, selectedStreamIds, allStreams, allMappings, onBatchApply, onBatchVisibility, onBatchMoveToTop }: {
  stream: any;
  mapping?: StreamMapping;
  playlistId: string;
  type: string;
  source?: UpstreamSource;
  playlist?: Playlist;
  globalFormat?: string;
  onClose: () => void;
  onUpdate: () => void;
  selectedStreamIds?: Set<string>;
  allStreams?: any[];
  allMappings?: StreamMapping[];
  onBatchApply?: (rules: { pattern: string; replacement: string }[]) => void;
  onBatchVisibility?: (hidden: boolean) => void;
  onBatchMoveToTop?: () => void;
}) {
  const [customName, setCustomName] = useState(mapping?.customName || "");
  const [customIcon, setCustomIcon] = useState(mapping?.customIcon || "");
  const [epgMapping, setEpgMapping] = useState(mapping?.epgMapping || "");
  const [loading, setLoading] = useState(false);
  const [showTechInfo, setShowTechInfo] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // EPG channel search
  const [epgChannels, setEpgChannels] = useState<{id: string; name: string; icon?: string; source: string}[]>([]);
  const [epgSearch, setEpgSearch] = useState('');
  const [epgOpen, setEpgOpen] = useState(false);
  const epgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.epgs.channels(playlistId).then(r => setEpgChannels(r.channels)).catch(() => {});
  }, [playlistId]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (epgRef.current && !epgRef.current.contains(e.target as Node)) setEpgOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Normalize for fuzzy matching
  const normalize = (s: string) =>
    s.toLowerCase().replace(/\b(hd|fhd|4k|sd|uhd|the|le|la|les|das|der|die)\b/gi, '').replace(/[^a-z0-9]/g, '').trim();

  const autoMatch = () => {
    const target = normalize(customName || stream.name || stream.title || '');
    let best: {id: string; name: string; icon?: string} | null = null;
    let bestScore = 0;
    for (const ch of epgChannels) {
      const n = normalize(ch.name);
      if (n === target) { best = ch; break; }
      if (!best) { best = ch; bestScore = 0; }
      // Score: starts-with > contains
      const score = n.startsWith(target) || target.startsWith(n) ? 2 : n.includes(target) || target.includes(n) ? 1 : 0;
      if (score > bestScore) { best = ch; bestScore = score; }
    }
    if (best && bestScore > 0) {
      setEpgMapping(best.id);
      if (best.icon && !customIcon) setCustomIcon(best.icon);
    }
  };

  const filteredEpg = epgChannels.filter(ch => {
    const q = (epgSearch || epgMapping).toLowerCase();
    return !q || ch.name.toLowerCase().includes(q) || ch.id.toLowerCase().includes(q);
  }).slice(0, 50);

  const selectedChannel = epgChannels.find(ch => ch.id === epgMapping);

  useEffect(() => {
    setCustomName(mapping?.customName || "");
    setCustomIcon(mapping?.customIcon || "");
    setEpgMapping(mapping?.epgMapping || "");
    setEpgSearch('');
    setEpgOpen(false);
  }, [mapping, stream._uniqueId]);

  const originalName = stream.name || stream.title || "";
  const originalIcon = stream.stream_icon || stream.cover || "";
  const originalEpg = stream.epg_channel_id || "";

  const handleSave = async () => {
    setLoading(true);
    try {
      const epgIcon = selectedChannel?.icon || '';
      const sharedData = {
        customIcon: customIcon,
        epgMapping: epgMapping,
        epgIcon: epgIcon,
        epgSource: selectedChannel?.source || '',
      };

      if (selectedStreamIds && selectedStreamIds.size > 1 && allStreams && allMappings) {
        // Batch update all selected streams (EPG/icon fields only, not name)
        const updates = Array.from(selectedStreamIds).map(streamId => {
          const s = allStreams.find(s => s._uniqueId === streamId);
          const m = allMappings.find(m => m.originalId === streamId && m.type === type);
          if (!s) return null;
          return {
            ...(m?.id ? { id: m.id } : {
              originalId: streamId,
              playlistId,
              type,
              originalName: s.name || s.title || '',
              order: m?.order || 0,
              hidden: m?.hidden || false,
              categoryId: String(s.category_id || ''),
              customName: m?.customName || s.name || s.title || '',
            }),
            ...sharedData,
          };
        }).filter(Boolean);
        await api.mappings.batchUpdate(updates as any[]);
      } else {
        const data = { customName: customName || originalName, ...sharedData };
        if (mapping?.id) {
          await api.mappings.update(mapping.id, data);
        } else {
          await api.mappings.create({
            playlistId,
            type,
            originalId: stream._uniqueId,
            originalName,
            order: mapping?.order || 0,
            hidden: mapping?.hidden || false,
            categoryId: String(stream.category_id || ""),
            ...data
          });
        }
      }
      onUpdate();
      onClose();
    } catch (error) {
      console.error('Failed to save mapping:', error);
    }
    setLoading(false);
  };

  const isMulti = selectedStreamIds && selectedStreamIds.size > 1;

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 360, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      className="border-l border-zinc-800 bg-zinc-900 shadow-2xl flex flex-col z-20 shrink-0 overflow-hidden"
    >
      {/* Compact header: icon + name inline */}
      <header className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/50 flex items-center gap-3 min-w-0">
        {isMulti ? (
          <div className="w-9 h-9 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center text-emerald-500 font-bold text-sm shrink-0">
            {selectedStreamIds.size}
          </div>
        ) : (
          <div className="w-9 h-9 rounded-xl overflow-hidden bg-zinc-950 border border-zinc-800 shrink-0 flex items-center justify-center">
            {(customIcon || originalIcon) ? (
              <img src={customIcon || originalIcon} alt="" className="w-full h-full object-contain p-0.5" referrerPolicy="no-referrer" />
            ) : (
              <Tv size={16} className="text-zinc-700" />
            )}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate text-zinc-100 leading-tight">
            {isMulti ? `${selectedStreamIds.size} streams selected` : (customName || originalName)}
          </p>
          <p className="text-[10px] text-zinc-600 font-mono leading-tight">
            {isMulti ? 'EPG and logo apply to all' : `ID: ${stream._uniqueId}`}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-100 shrink-0">
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">

          {/* Name + Logo — hidden in multi-select */}
          {!isMulti && (
            <>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Display Name</label>
                <input
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                  placeholder={originalName}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:border-emerald-500 outline-none transition-all"
                />
              </div>

              {/* Detected Quality */}
              <div className="space-y-2 border border-zinc-800 rounded-xl p-3">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Detected Quality</label>
                  <button
                    onClick={async () => {
                      const streamId = mapping?.originalId ?? stream._uniqueId ?? String(stream.stream_id);
                      setScanLoading(true);
                      setScanError(null);
                      try {
                        const { jobId } = await api.qualityScan.start({
                          playlistId,
                          streamIds: [streamId],
                          type: type as 'live' | 'vod' | 'series',
                          concurrency: 1,
                        });
                        let job: any;
                        do {
                          await new Promise(r => setTimeout(r, 2000));
                          job = await api.qualityScan.status(jobId);
                        } while (job.status === 'running');
                        const result = job.results.find((r: any) => r.streamId === streamId);
                        if (result?.meta) {
                          onUpdate(); // backend upserted the mapping — just refresh
                        } else if (result?.error) {
                          setScanError(result.error);
                        }
                      } catch (e: any) {
                        setScanError(e.message || 'Scan failed');
                      } finally {
                        setScanLoading(false);
                      }
                    }}
                    disabled={scanLoading}
                    className="text-[10px] text-emerald-500 hover:underline font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {scanLoading ? 'Scanning...' : 'Scan this channel'}
                  </button>
                </div>
                {scanError && <p className="text-xs text-red-400 mt-1">{scanError}</p>}

                {mapping?.detectedMeta ? (
                  <div className="flex flex-wrap gap-1">
                    {mapping.detectedMeta.resolution && (
                      <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">{mapping.detectedMeta.resolution}</span>
                    )}
                    {mapping.detectedMeta.videoCodec && (
                      <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">{mapping.detectedMeta.videoCodec.toUpperCase()}</span>
                    )}
                    {mapping.detectedMeta.hdr && (
                      <span className="px-1.5 py-0.5 bg-amber-500/15 border border-amber-500/30 rounded text-[10px] font-mono text-amber-400">{mapping.detectedMeta.hdr}</span>
                    )}
                    {mapping.detectedMeta.audioCodec && (
                      <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">
                        {mapping.detectedMeta.audioCodec.toUpperCase()}{mapping.detectedMeta.audioChannels ? ` ${mapping.detectedMeta.audioChannels}ch` : ''}
                      </span>
                    )}
                    {mapping.detectedMeta.fps && (
                      <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">{mapping.detectedMeta.fps}fps</span>
                    )}
                    {mapping.detectedMeta.scannedAt && (
                      <span className="px-1.5 py-0.5 text-[10px] text-zinc-600">Scanned {new Date(mapping.detectedMeta.scannedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-zinc-600 italic">Not scanned yet</p>
                )}

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!mapping?.useDetectedQuality}
                    onChange={async e => {
                      if (!mapping?.id) return;
                      await api.mappings.update(mapping.id, { useDetectedQuality: e.target.checked } as any);
                      onUpdate();
                    }}
                    disabled={!mapping?.detectedMeta?.resolution}
                    className="rounded accent-emerald-500"
                  />
                  <span className="text-xs text-zinc-400">Show quality in name</span>
                </label>

                {mapping?.useDetectedQuality && mapping?.detectedMeta?.resolution && (
                  <p className="text-[10px] text-zinc-500 truncate">
                    Preview: &ldquo;{computeDisplayName(mapping, playlist?.qualityLabelFormat, globalFormat)}&rdquo;
                  </p>
                )}
              </div>

            </>
          )}

          {/* Logo URL — visible in single and multi-select */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
              Logo URL{isMulti ? ' (applies to all selected)' : ''}
            </label>
            <div className="flex gap-2 items-start">
              <input
                value={customIcon}
                onChange={e => setCustomIcon(e.target.value)}
                placeholder="https://..."
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:border-emerald-500 outline-none transition-all font-mono"
              />
              <div className="w-10 h-10 rounded-lg overflow-hidden bg-zinc-950 border border-zinc-800 shrink-0 flex items-center justify-center">
                {(customIcon || originalIcon) ? (
                  <img src={customIcon || originalIcon} alt="" className="w-full h-full object-contain p-0.5" referrerPolicy="no-referrer" onError={e => (e.currentTarget.style.display='none')} />
                ) : (
                  <Tv size={14} className="text-zinc-700" />
                )}
              </div>
            </div>
            {!isMulti && originalIcon && customIcon && (
              <button onClick={() => setCustomIcon("")} className="text-[10px] text-emerald-500 hover:underline">
                Reset to default
              </button>
            )}
          </div>

          {/* Quality label toggle — multi-select only */}
          {isMulti && allMappings && selectedStreamIds && (
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Quality Label</label>
              {(() => {
                const scanned = Array.from(selectedStreamIds).filter(id => allMappings.find(m => m.originalId === id && m.type === type)?.detectedMeta?.resolution);
                if (!scanned.length) return <p className="text-[10px] text-zinc-600 italic">No scanned channels in selection</p>;
                return (
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        const updates = scanned.map(id => allMappings.find(m => m.originalId === id && m.type === type)).filter((m): m is StreamMapping => !!m?.id).map(m => ({ id: m.id, useDetectedQuality: true }));
                        if (updates.length) { await api.mappings.batchUpdate(updates); onUpdate(); }
                      }}
                      className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"
                    >
                      Enable ({scanned.length})
                    </button>
                    <button
                      onClick={async () => {
                        const updates = scanned.map(id => allMappings.find(m => m.originalId === id && m.type === type)).filter((m): m is StreamMapping => !!m?.id).map(m => ({ id: m.id, useDetectedQuality: false }));
                        if (updates.length) { await api.mappings.batchUpdate(updates); onUpdate(); }
                      }}
                      className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-all"
                    >
                      Disable
                    </button>
                  </div>
                );
              })()}
            </div>
          )}

          {/* EPG Channel */}
          <div className="space-y-1.5" ref={epgRef}>
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">EPG Channel</label>
              <div className="flex items-center gap-2">
                {epgChannels.length > 0 && (
                  <button onClick={autoMatch} className="text-[10px] text-emerald-500 hover:underline font-bold" title="Auto-match by name">
                    Auto-match
                  </button>
                )}
                {epgMapping && (
                  <button onClick={() => { setEpgMapping(''); setEpgSearch(''); }} className="text-[10px] text-zinc-500 hover:text-red-400">
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="relative">
              <div
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm focus-within:border-emerald-500 transition-all cursor-pointer flex items-center gap-2"
                onClick={() => { setEpgOpen(o => !o); setEpgSearch(''); }}
              >
                {selectedChannel?.icon && (
                  <img src={selectedChannel.icon} alt="" className="w-5 h-5 object-contain rounded shrink-0" onError={e => (e.currentTarget.style.display='none')} />
                )}
                <span className={`flex-1 truncate font-mono text-xs ${epgMapping ? 'text-zinc-100' : 'text-zinc-600'}`}>
                  {selectedChannel ? selectedChannel.name : epgMapping || (originalEpg ? `Using: ${originalEpg}` : 'Select EPG channel...')}
                </span>
                {selectedChannel?.source && (() => { const c = epgSourceColor(selectedChannel.source); return (
                  <span className="text-[9px] rounded px-1 py-0.5 shrink-0 font-sans border" style={{ background: c.bg, borderColor: c.border, color: c.text }}>{selectedChannel.source}</span>
                ); })()}
                <ChevronDown size={14} className={`text-zinc-600 shrink-0 transition-transform ${epgOpen ? 'rotate-180' : ''}`} />
              </div>

              {epgOpen && (
                <div className="absolute z-50 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-zinc-800">
                    <input
                      autoFocus
                      value={epgSearch}
                      onChange={e => setEpgSearch(e.target.value)}
                      placeholder="Search channels..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:border-emerald-500 outline-none"
                      onClick={e => e.stopPropagation()}
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {epgChannels.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-zinc-600">
                        No EPG sources configured. Enable "Use Upstream EPG" on a source or add custom EPG sources.
                      </div>
                    ) : filteredEpg.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-zinc-600">No channels match</div>
                    ) : filteredEpg.map(ch => (
                      <button
                        key={ch.id}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800 transition-colors ${ch.id === epgMapping ? 'bg-emerald-500/10 text-emerald-400' : ''}`}
                        onClick={() => { setEpgMapping(ch.id); setEpgOpen(false); setEpgSearch(''); if (ch.icon && !customIcon) setCustomIcon(ch.icon); }}
                      >
                        {ch.icon && (
                          <img src={ch.icon} alt="" className="w-6 h-6 object-contain rounded shrink-0" onError={e => (e.currentTarget.style.display='none')} />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium truncate">{ch.name}</span>
                            {(() => { const c = epgSourceColor(ch.source); return (
                              <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded border truncate max-w-[120px]" style={{ background: c.bg, borderColor: c.border, color: c.text }}>{ch.source}</span>
                            ); })()}
                          </div>
                          <div className="text-[10px] text-zinc-600 font-mono truncate">{ch.id}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {epgMapping && (
              <p className="text-[10px] text-zinc-600 font-mono truncate">ID: {epgMapping}</p>
            )}
            {!epgMapping && originalEpg && (
              <p className="text-[10px] text-zinc-600">Original: <span className="italic font-mono">{originalEpg}</span></p>
            )}
          </div>

          {/* Technical info — collapsed by default */}
          <div className="border border-zinc-800 rounded-xl overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase font-bold text-zinc-600 tracking-wider hover:bg-zinc-800/50 transition-colors"
              onClick={() => setShowTechInfo(v => !v)}
            >
              <span>Technical Info</span>
              <ChevronDown size={12} className={`transition-transform ${showTechInfo ? 'rotate-180' : ''}`} />
            </button>
            {showTechInfo && (
              <div className="px-3 pb-3 space-y-3 border-t border-zinc-800">
                <div className="grid grid-cols-2 gap-1 text-[10px] pt-2">
                  <div className="text-zinc-600">Type: {type}</div>
                  <div className="text-zinc-600">Mapped: {mapping ? "Yes" : "No"}</div>
                  <div className="text-zinc-600 col-span-2 truncate">Category: {stream.category_name || stream.category_id}</div>
                </div>
                {source && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase font-bold text-zinc-600">Upstream URL</label>
                      <div className="flex gap-1.5">
                        <code className="flex-1 bg-zinc-900 p-1.5 rounded text-[9px] text-zinc-400 break-all font-mono border border-zinc-800">
                          {source.url.replace(/\/$/, '')}/{type === 'live' ? 'live' : type === 'vod' ? 'movie' : 'series'}/{source.username}/{source.password}/{stream.stream_id || stream.series_id}{type === 'live' ? '.ts' : '.mp4'}
                        </code>
                        <button onClick={() => { const url = `${source.url.replace(/\/$/, '')}/${type === 'live' ? 'live' : type === 'vod' ? 'movie' : 'series'}/${source.username}/${source.password}/${stream.stream_id || stream.series_id}${type === 'live' ? '.ts' : '.mp4'}`; navigator.clipboard.writeText(url); }} className="p-1.5 bg-zinc-900 border border-zinc-800 rounded hover:text-emerald-500 transition-colors shrink-0">
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                    {playlist && (
                      <div className="space-y-1">
                        <label className="text-[9px] uppercase font-bold text-zinc-600">Proxy URL</label>
                        <div className="flex gap-1.5">
                          <code className="flex-1 bg-zinc-900 p-1.5 rounded text-[9px] text-emerald-500/70 break-all font-mono border border-emerald-500/10">
                            {window.location.origin}/{type === 'live' ? 'live' : type === 'vod' ? 'movie' : 'series'}/{playlist.username}/{playlist.password}/{stream.stream_id || stream.series_id}{type === 'live' ? '.ts' : '.mp4'}
                          </code>
                          <button onClick={() => { const url = `${window.location.origin}/${type === 'live' ? 'live' : type === 'vod' ? 'movie' : 'series'}/${playlist.username}/${playlist.password}/${stream.stream_id || stream.series_id}${type === 'live' ? '.ts' : '.mp4'}`; navigator.clipboard.writeText(url); }} className="p-1.5 bg-zinc-900 border border-zinc-800 rounded hover:text-emerald-500 transition-colors shrink-0">
                            <ExternalLink size={11} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {isMulti && onBatchApply && onBatchVisibility && onBatchMoveToTop && (
            <>
              <div className="h-px w-full bg-zinc-800/50" />
              <BatchActionsSection
                streamIds={Array.from(selectedStreamIds ?? new Set())}
                playlistId={playlistId}
                activeTab={type as 'live' | 'vod' | 'series'}
                mappings={allMappings ?? []}
                playlist={playlist ?? null}
                onRefresh={onUpdate}
                onBatchApply={onBatchApply}
                onBatchVisibility={onBatchVisibility}
                onBatchMoveToTop={onBatchMoveToTop}
              />
            </>
          )}

        </div>
      </div>

      <div className="p-3 border-t border-zinc-800 bg-zinc-950/50 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl font-bold hover:bg-zinc-700 transition-all text-sm"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={loading}
          className="flex-1 py-2.5 bg-emerald-500 text-zinc-950 rounded-xl font-bold hover:bg-emerald-400 transition-all text-sm disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </motion.aside>
  );
}

export function UserManager({ user }: { user: User }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.admin.listUsers();
      setUsers(data);
    } catch (err) {
      console.error("Failed to load users:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleDelete = async (targetId: string, email: string) => {
    if (!confirm(`Are you absolutely sure you want to delete user ${email}? \n\nTHIS WILL DELETE ALL THEIR PLAYLISTS AND DATA. THIS CANNOT BE UNDONE.`)) {
      return;
    }

    try {
      await api.admin.deleteUser(targetId);
      loadUsers();
    } catch (err) {
      alert("Failed to delete user");
    }
  };

  if (loading && users.length === 0) {
    return <div className="p-8 animate-pulse text-zinc-500">Loading users...</div>;
  }

  return (
    <div className="p-8 space-y-8 max-w-5xl mx-auto">
      <header>
        <h2 className="text-3xl font-black tracking-tight text-zinc-100">User Management</h2>
        <p className="text-zinc-500">Manage system accounts and their associated data</p>
      </header>

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">User Email</th>
              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500 text-center">Playlists</th>
              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Role</th>
              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {users.map((u) => (
              <tr key={u.id} className="group hover:bg-zinc-800/30 transition-all">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 font-bold text-xs">
                      {u.email[0].toUpperCase()}
                    </div>
                    <span className="font-medium text-zinc-100">{u.email}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className="px-3 py-1 bg-zinc-800 rounded-full text-xs font-bold text-zinc-400 border border-zinc-700">
                    {u.playlistCount}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-tighter border ${
                    u.role === 'admin' ? 'bg-purple-500/10 text-purple-500 border-purple-500/20' : 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  {u.id !== user.id && (
                    <button 
                      onClick={() => handleDelete(u.id, u.email)}
                      className="p-2 text-zinc-600 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all"
                      title="Delete User"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                  {u.id === user.id && (
                    <span className="text-[10px] text-zinc-600 uppercase font-black italic">Current User</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }

