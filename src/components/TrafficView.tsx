import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { User, TrafficStatsResponse, PlaylistTrafficSummary } from '../types';
import {
  Activity,
  Calendar,
  ArrowUpDown,
  Search,
  RefreshCw,
  Tv,
  Film,
  Layers,
  AlertTriangle,
  HardDrive,
  Trash2,
  CheckCircle2,
} from 'lucide-react';

interface TrafficViewProps {
  user: User;
}

type RangePreset = 'this_month' | 'last_month' | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'all_time' | 'custom';
type SortField = 'total' | 'live' | 'series' | 'movie' | 'name';

export function formatBytes(bytes: number, decimals: number = 2): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const safeI = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, safeI)).toFixed(dm))} ${sizes[safeI]}`;
}

function getPresetDates(preset: RangePreset): { start?: string; end?: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (preset) {
    case 'this_month': {
      const start = `${now.toISOString().slice(0, 7)}-01`;
      return { start, end: today };
    }
    case 'last_month': {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDayOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        start: prevMonth.toISOString().slice(0, 10),
        end: lastDayOfPrevMonth.toISOString().slice(0, 10),
      };
    }
    case 'today':
      return { start: today, end: today };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const yStr = y.toISOString().slice(0, 10);
      return { start: yStr, end: yStr };
    }
    case 'last_7_days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { start: d.toISOString().slice(0, 10), end: today };
    }
    case 'last_30_days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { start: d.toISOString().slice(0, 10), end: today };
    }
    case 'all_time':
      return { start: '2020-01-01', end: today };
    case 'custom':
    default:
      return {};
  }
}

export function TrafficView({ user }: TrafficViewProps) {
  const [preset, setPreset] = useState<RangePreset>('this_month');
  const [customStart, setCustomStart] = useState<string>(() => `${new Date().toISOString().slice(0, 7)}-01`);
  const [customEnd, setCustomEnd] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [stats, setStats] = useState<TrafficStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('total');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);

  const fetchStats = useCallback(async (isSilent: boolean = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);

    try {
      let dates: { start?: string; end?: string } = {};
      if (preset === 'custom') {
        dates = { start: customStart, end: customEnd };
      } else {
        dates = getPresetDates(preset);
      }

      const data = await api.traffic.getStats({
        startDate: dates.start,
        endDate: dates.end,
      });
      setStats(data);
    } catch (err: any) {
      console.error('Failed to load traffic stats:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [preset, customStart, customEnd]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleResetAll = async () => {
    if (!confirm('Möchtest du wirklich alle aufgezeichneten Traffic-Statistiken unwiderruflich zurücksetzen?')) {
      return;
    }
    setResetting(true);
    try {
      await api.traffic.reset();
      await fetchStats();
    } catch (err: any) {
      alert(`Fehler beim Zurücksetzen: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  const filteredPlaylists = useMemo(() => {
    if (!stats) return [];
    let list = stats.byPlaylist.filter(p =>
      p.playlistName.toLowerCase().includes(search.toLowerCase()) ||
      p.playlistId.toLowerCase().includes(search.toLowerCase())
    );

    list.sort((a, b) => {
      let diff = 0;
      if (sortField === 'total') diff = a.totalBytes - b.totalBytes;
      else if (sortField === 'live') diff = a.byType.live - b.byType.live;
      else if (sortField === 'series') diff = a.byType.series - b.byType.series;
      else if (sortField === 'movie') diff = a.byType.movie - b.byType.movie;
      else if (sortField === 'name') return sortAsc ? a.playlistName.localeCompare(b.playlistName) : b.playlistName.localeCompare(a.playlistName);

      return sortAsc ? diff : -diff;
    });

    return list;
  }, [stats, search, sortField, sortAsc]);

  const monthQuotaGB = stats ? stats.summary.monthlyQuotaBytes / (1024 * 1024 * 1024) : 10240;
  const monthPercent = stats ? stats.summary.monthPercent : 0;
  const remainingMonthBytes = stats
    ? Math.max(0, stats.summary.monthlyQuotaBytes - stats.summary.monthBytes)
    : 0;

  // Max daily bytes for chart scaling
  const maxDailyBytes = useMemo(() => {
    if (!stats || !stats.daily.length) return 1;
    return Math.max(...stats.daily.map(d => d.totalBytes), 1);
  }, [stats]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-zinc-100">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Activity className="text-emerald-500" size={24} />
            Traffic & Datenverbrauch
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Übertragenes Datenvolumen aller Client-Verbindungen (z.B. für Oracle Cloud Free Tier 10 TB Egress-Kontingent).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchStats(true)}
            disabled={refreshing || loading}
            className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
            title="Statistiken aktualisieren"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin text-emerald-500" : ""} />
            <span>Aktualisieren</span>
          </button>

          {user.role === 'admin' && (
            <button
              onClick={handleResetAll}
              disabled={resetting || loading}
              className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
              title="Alle Traffic-Statistiken zurücksetzen"
            >
              <Trash2 size={14} />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Hero: Monthly Quota Progress (Oracle Free Tier) */}
      <div className="bg-gradient-to-br from-zinc-900 via-zinc-900/90 to-zinc-950 border border-zinc-800/90 rounded-2xl p-5 shadow-xl relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                <HardDrive size={15} className="text-emerald-400" />
                Monatsverbrauch (seit 01. des Monats)
              </span>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                monthPercent > 90 ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                monthPercent > 75 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              }`}>
                {monthPercent}% verbraucht
              </span>
            </div>

            <div className="flex items-baseline gap-3">
              <div className="text-3xl sm:text-4xl font-black tracking-tight text-zinc-100 tabular-nums">
                {stats ? formatBytes(stats.summary.monthBytes) : '0 GB'}
              </div>
              <div className="text-sm font-semibold text-zinc-400">
                von {formatBytes(stats?.summary.monthlyQuotaBytes || 0)} Kontingent
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              Noch <span className="text-zinc-300 font-semibold">{formatBytes(remainingMonthBytes)}</span> im aktuellen Monat bis zum Limit frei.
            </p>
          </div>

          <div className="lg:w-72 flex flex-col justify-center space-y-2">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>0 GB</span>
              <span className="font-semibold text-zinc-300">{monthPercent}%</span>
              <span>{Math.round(monthQuotaGB / 1024 * 10) / 10} TB</span>
            </div>

            {/* Multi-tier Progress Bar */}
            <div className="w-full bg-zinc-950 border border-zinc-800 h-3.5 rounded-full overflow-hidden p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  monthPercent > 90
                    ? 'bg-gradient-to-r from-red-600 to-red-400'
                    : monthPercent > 75
                    ? 'bg-gradient-to-r from-amber-500 to-amber-300'
                    : 'bg-gradient-to-r from-emerald-600 to-emerald-400'
                }`}
                style={{ width: `${Math.min(100, Math.max(1, monthPercent))}%` }}
              />
            </div>

            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              {monthPercent < 75 ? (
                <>
                  <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                  <span>Oracle Free Tier Traffic im optimalen Bereich</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                  <span>Achtung: Monatslimit nähert sich</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl">
          <div className="text-[11px] text-zinc-400 font-semibold uppercase tracking-wider mb-1">Heute verbraucht</div>
          <div className="text-2xl font-bold text-zinc-100 tabular-nums">
            {stats ? formatBytes(stats.summary.todayBytes) : '...'}
          </div>
        </div>

        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl">
          <div className="text-[11px] text-zinc-400 font-semibold uppercase tracking-wider mb-1">Ausgewählter Zeitraum</div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">
            {stats ? formatBytes(stats.totalBytes) : '...'}
          </div>
        </div>

        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl">
          <div className="text-[11px] text-zinc-400 font-semibold uppercase tracking-wider mb-1">Gesamt seit Beginn</div>
          <div className="text-2xl font-bold text-zinc-200 tabular-nums">
            {stats ? formatBytes(stats.summary.allTimeBytes) : '...'}
          </div>
        </div>

        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl">
          <div className="text-[11px] text-zinc-400 font-semibold uppercase tracking-wider mb-1">Aktive Playlists im Zeitraum</div>
          <div className="text-2xl font-bold text-purple-400 tabular-nums">
            {stats ? stats.byPlaylist.length : 0}
          </div>
        </div>
      </div>

      {/* Stream Type Breakdown Cards (TV, Serie, VOD) */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Layers size={17} className="text-emerald-400" />
              Aufschlüsselung nach Medientyp im Zeitraum
            </h3>
            <p className="text-xs text-zinc-500">Live TV, Serien und Filme (VOD)</p>
          </div>

          <div className="text-xs text-zinc-400">
            Gesamt: <span className="text-zinc-200 font-bold">{stats ? formatBytes(stats.totalBytes) : '0 B'}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Live TV */}
          {(() => {
            const liveBytes = stats?.byType.live || 0;
            const total = stats?.totalBytes || 1;
            const pct = Math.round((liveBytes / total) * 1000) / 10;
            return (
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800/90 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Tv size={14} className="text-blue-400" />
                    Live TV
                  </span>
                  <span className="text-[11px] font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                    {pct}%
                  </span>
                </div>
                <div className="text-xl font-bold text-zinc-100 tabular-nums">{formatBytes(liveBytes)}</div>
                <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-blue-500 h-full rounded-full" style={{ width: `${Math.max(1, pct)}%` }} />
                </div>
              </div>
            );
          })()}

          {/* Series */}
          {(() => {
            const seriesBytes = stats?.byType.series || 0;
            const total = stats?.totalBytes || 1;
            const pct = Math.round((seriesBytes / total) * 1000) / 10;
            return (
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800/90 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Film size={14} className="text-purple-400" />
                    Serien
                  </span>
                  <span className="text-[11px] font-bold text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
                    {pct}%
                  </span>
                </div>
                <div className="text-xl font-bold text-zinc-100 tabular-nums">{formatBytes(seriesBytes)}</div>
                <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-purple-500 h-full rounded-full" style={{ width: `${Math.max(1, pct)}%` }} />
                </div>
              </div>
            );
          })()}

          {/* Movies / VOD */}
          {(() => {
            const movieBytes = stats?.byType.movie || 0;
            const total = stats?.totalBytes || 1;
            const pct = Math.round((movieBytes / total) * 1000) / 10;
            return (
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800/90 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Film size={14} className="text-amber-400" />
                    Filme / VOD
                  </span>
                  <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                    {pct}%
                  </span>
                </div>
                <div className="text-xl font-bold text-zinc-100 tabular-nums">{formatBytes(movieBytes)}</div>
                <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-amber-500 h-full rounded-full" style={{ width: `${Math.max(1, pct)}%` }} />
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Date Range Selector Bar */}
      <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider">
            <Calendar size={14} className="text-emerald-400" />
            Zeitraum auswählen
          </div>

          {stats && (
            <div className="text-xs text-zinc-400">
              Von <span className="text-zinc-200 font-semibold">{stats.range.startDate}</span> bis{' '}
              <span className="text-zinc-200 font-semibold">{stats.range.endDate}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { id: 'this_month', label: 'Diesen Monat' },
            { id: 'last_month', label: 'Letzten Monat' },
            { id: 'today', label: 'Heute' },
            { id: 'yesterday', label: 'Gestern' },
            { id: 'last_7_days', label: 'Letzte 7 Tage' },
            { id: 'last_30_days', label: 'Letzte 30 Tage' },
            { id: 'all_time', label: 'Gesamt' },
            { id: 'custom', label: 'Benutzerdefiniert' },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id as RangePreset)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                preset === p.id
                  ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                  : 'bg-zinc-950 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Von:</span>
              <input
                type="date"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:border-emerald-500 outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Bis:</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:border-emerald-500 outline-none"
              />
            </div>
            <button
              onClick={() => fetchStats()}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-semibold transition-all"
            >
              Anwenden
            </button>
          </div>
        )}
      </div>

      {/* Daily Timeline Chart */}
      {stats && stats.daily.length > 0 && (
        <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-zinc-100">Täglicher Traffic-Verlauf</h3>
              <p className="text-xs text-zinc-500">Volumen pro Tag im gewählten Zeitraum</p>
            </div>
            <div className="text-xs text-zinc-400">
              Spitzentag:{' '}
              <span className="text-emerald-400 font-bold">{formatBytes(maxDailyBytes)}</span>
            </div>
          </div>

          <div className="pt-4 overflow-x-auto custom-scrollbar">
            <div className="flex items-end gap-2 min-w-full h-40 pb-2">
              {stats.daily.map(d => {
                const heightPct = Math.max(4, Math.round((d.totalBytes / maxDailyBytes) * 100));
                const dayLabel = d.date.slice(5); // MM-DD
                return (
                  <div
                    key={d.date}
                    className="flex-1 min-w-[28px] max-w-[56px] flex flex-col items-center gap-1.5 group relative"
                  >
                    {/* Tooltip on hover */}
                    <div className="absolute bottom-full mb-2 hidden group-hover:flex flex-col items-center z-30 pointer-events-none">
                      <div className="bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-[11px] shadow-xl text-center whitespace-nowrap space-y-0.5">
                        <div className="font-bold text-zinc-200">{d.date}</div>
                        <div className="text-emerald-400 font-black">{formatBytes(d.totalBytes)}</div>
                        <div className="text-[9px] text-zinc-400 flex gap-2 justify-center">
                          <span>TV: {formatBytes(d.byType.live)}</span>
                          <span>Serie: {formatBytes(d.byType.series)}</span>
                          <span>VOD: {formatBytes(d.byType.movie)}</span>
                        </div>
                      </div>
                      <div className="w-2 h-2 bg-zinc-950 border-r border-b border-zinc-700 transform rotate-45 -mt-1" />
                    </div>

                    {/* Stacked or Gradient Bar */}
                    <div className="w-full flex flex-col justify-end bg-zinc-950 rounded-t-md overflow-hidden h-32 p-0.5">
                      <div
                        className="w-full rounded-t bg-gradient-to-t from-emerald-600 to-emerald-400 group-hover:from-emerald-500 group-hover:to-emerald-300 transition-all"
                        style={{ height: `${heightPct}%` }}
                      />
                    </div>

                    {/* Day label */}
                    <span className="text-[10px] text-zinc-400 font-mono tracking-tighter truncate w-full text-center">
                      {dayLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Playlist Breakdown Table */}
      <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-zinc-100">Verbrauch pro Playlist</h3>
            <p className="text-xs text-zinc-500">Sortiert nach übertragener Datenmenge</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Playlist filtern..."
                className="bg-zinc-950 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 outline-none w-48 sm:w-60"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-zinc-500 animate-pulse text-sm">
            Statistiken werden geladen...
          </div>
        ) : filteredPlaylists.length === 0 ? (
          <div className="p-12 text-center space-y-2">
            <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto text-zinc-500">
              <Activity size={20} />
            </div>
            <p className="text-sm font-semibold text-zinc-400">Keine Datenübertragungen in diesem Zeitraum</p>
            <p className="text-xs text-zinc-600 max-w-sm mx-auto">
              Sobald Clients über Gecko Streams wiedergeben, werden hier genaue Datenmengen pro Playlist und Medientyp angezeigt.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/70 border-b border-zinc-800 text-zinc-400 uppercase text-[10px] tracking-wider font-semibold">
                <tr>
                  <th
                    className="p-3.5 cursor-pointer hover:text-zinc-200 transition-colors"
                    onClick={() => { setSortField('name'); setSortAsc(f => !f); }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span>Playlist</span>
                      <ArrowUpDown size={12} className={sortField === 'name' ? 'text-emerald-400' : 'text-zinc-600'} />
                    </div>
                  </th>
                  <th
                    className="p-3.5 cursor-pointer hover:text-zinc-200 transition-colors text-right"
                    onClick={() => { setSortField('live'); setSortAsc(f => !f); }}
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>Live TV</span>
                      <ArrowUpDown size={12} className={sortField === 'live' ? 'text-emerald-400' : 'text-zinc-600'} />
                    </div>
                  </th>
                  <th
                    className="p-3.5 cursor-pointer hover:text-zinc-200 transition-colors text-right"
                    onClick={() => { setSortField('series'); setSortAsc(f => !f); }}
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>Serien</span>
                      <ArrowUpDown size={12} className={sortField === 'series' ? 'text-emerald-400' : 'text-zinc-600'} />
                    </div>
                  </th>
                  <th
                    className="p-3.5 cursor-pointer hover:text-zinc-200 transition-colors text-right"
                    onClick={() => { setSortField('movie'); setSortAsc(f => !f); }}
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>Filme / VOD</span>
                      <ArrowUpDown size={12} className={sortField === 'movie' ? 'text-emerald-400' : 'text-zinc-600'} />
                    </div>
                  </th>
                  <th
                    className="p-3.5 cursor-pointer hover:text-zinc-200 transition-colors text-right"
                    onClick={() => { setSortField('total'); setSortAsc(f => !f); }}
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>Gesamt</span>
                      <ArrowUpDown size={12} className={sortField === 'total' ? 'text-emerald-400' : 'text-zinc-600'} />
                    </div>
                  </th>
                  <th className="p-3.5 text-right w-44">
                    <span>Anteil</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredPlaylists.map((p: PlaylistTrafficSummary) => {
                  const totalRange = stats?.totalBytes || 1;
                  const sharePct = Math.round((p.totalBytes / totalRange) * 1000) / 10;

                  return (
                    <tr key={p.playlistId} className="hover:bg-zinc-800/40 transition-colors group">
                      <td className="p-3.5 font-semibold text-zinc-200">
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-[200px] sm:max-w-xs">{p.playlistName}</span>
                          {p.playlistId !== 'unknown' && (
                            <span className="text-[10px] text-zinc-500 font-mono">({p.playlistId.slice(0, 8)})</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3.5 text-right font-mono text-zinc-300 tabular-nums">
                        {p.byType.live > 0 ? (
                          <span className="text-blue-400 font-semibold">{formatBytes(p.byType.live)}</span>
                        ) : (
                          <span className="text-zinc-600">-</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right font-mono text-zinc-300 tabular-nums">
                        {p.byType.series > 0 ? (
                          <span className="text-purple-400 font-semibold">{formatBytes(p.byType.series)}</span>
                        ) : (
                          <span className="text-zinc-600">-</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right font-mono text-zinc-300 tabular-nums">
                        {p.byType.movie > 0 ? (
                          <span className="text-amber-400 font-semibold">{formatBytes(p.byType.movie)}</span>
                        ) : (
                          <span className="text-zinc-600">-</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right font-bold text-zinc-100 font-mono tabular-nums text-sm">
                        {formatBytes(p.totalBytes)}
                      </td>
                      <td className="p-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-[11px] text-zinc-400 font-semibold tabular-nums w-10 text-right">
                            {sharePct}%
                          </span>
                          <div className="w-20 bg-zinc-950 border border-zinc-800 h-2 rounded-full overflow-hidden">
                            <div
                              className="bg-emerald-500 h-full rounded-full"
                              style={{ width: `${Math.max(1, sharePct)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
