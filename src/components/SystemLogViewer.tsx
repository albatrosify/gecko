import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Activity,
  RefreshCw,
  Pause,
  Play,
  Search,
  X,
  Copy,
  Check,
  Download,
  ArrowDown,
  Maximize2,
  Minimize2,
  WrapText,
  Trash2,
} from 'lucide-react';
import api from '../api';

export interface ParsedLogLine {
  id: number;
  raw: string;
  time: string | null;
  tag: string | null;
  category: 'sync' | 'proxy' | 'epg' | 'http' | 'system';
  isError: boolean;
  isWarning: boolean;
  isSuccess: boolean;
  httpMethod?: string;
  httpPath?: string;
  httpStatus?: number;
  httpDuration?: string;
  httpClient?: string;
  content: string;
}

type FilterCategory = 'all' | 'errors' | 'warnings' | 'sync' | 'proxy' | 'epg' | 'http' | 'system';

const LIMIT_OPTIONS = [100, 250, 500, 1000, 2000] as const;

/**
 * Parses a single raw log entry string into structured fields.
 */
function parseLogLine(raw: string, id: number): ParsedLogLine {
  let line = raw;
  let time: string | null = null;
  let tag: string | null = null;
  let category: ParsedLogLine['category'] = 'system';

  // 1. Extract leading timestamp e.g. [3:15:42 PM] or [15:15:42] or [2026-09-18T...]
  const timeMatch = line.match(/^\[(\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?|\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*/i);
  if (timeMatch) {
    time = timeMatch[1];
    line = line.slice(timeMatch[0].length);
  }

  // 2. Check for tag in brackets e.g. [Sync], [Proxy], [EPG], [Cron]
  const tagMatch = line.match(/^\[([a-zA-Z0-9_\-\s]+)\]\s*/);
  if (tagMatch) {
    tag = tagMatch[1].trim();
    line = line.slice(tagMatch[0].length);
  }

  // 3. Determine category
  const lowerTag = (tag || '').toLowerCase();
  const lowerRaw = raw.toLowerCase();

  let httpMethod: string | undefined;
  let httpPath: string | undefined;
  let httpStatus: number | undefined;
  let httpDuration: string | undefined;
  let httpClient: string | undefined;

  // Check HTTP request patterns (e.g. "GET /api/channels 200 12ms - 192.168.1.5")
  const httpMatch = line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})\s+(\d+ms)?(?:\s*-\s*(.*))?/i);
  if (httpMatch) {
    category = 'http';
    httpMethod = httpMatch[1].toUpperCase();
    httpPath = httpMatch[2];
    httpStatus = parseInt(httpMatch[3], 10);
    httpDuration = httpMatch[4];
    httpClient = httpMatch[5]?.trim();
  } else if (lowerTag.includes('proxy') || lowerRaw.includes('[proxy]')) {
    category = 'proxy';
  } else if (
    lowerTag.includes('sync') ||
    lowerTag.includes('cron') ||
    lowerTag.includes('changelog') ||
    lowerTag.includes('xtream') ||
    lowerTag.includes('startup') ||
    lowerTag.includes('sources')
  ) {
    category = 'sync';
  } else if (lowerTag.includes('epg')) {
    category = 'epg';
  } else if (lowerTag.includes('monitor') || lowerTag.includes('host')) {
    category = 'system';
  }

  // 4. Determine severity
  const isError =
    /\b(error|err|failed|failure|rejected|crash|fatal|exception)\b/i.test(raw) ||
    /\bstatus\s*(?:code\s*)?(?:5\d\d|4\d\d)\b/i.test(raw) ||
    /(?:^|\s)(?:500|501|502|503|504|511)\b/.test(raw) ||
    (httpStatus !== undefined && httpStatus >= 400);

  const isWarning = !isError && /\b(warn|warning)\b/i.test(raw);
  const isSuccess = !isError && !isWarning && /\b(success|completed|healthy|recorded)\b/i.test(raw);

  return {
    id,
    raw,
    time,
    tag,
    category,
    isError,
    isWarning,
    isSuccess,
    httpMethod,
    httpPath,
    httpStatus,
    httpDuration,
    httpClient,
    content: line,
  };
}

/**
 * Returns tailored badge colors for tags.
 */
function getTagStyle(tag: string): string {
  const t = tag.toLowerCase();
  if (t.includes('proxy')) return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
  if (t.includes('sync')) return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
  if (t.includes('cron')) return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  if (t.includes('changelog')) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (t.includes('epg')) return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
  if (t.includes('xtream')) return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
  if (t.includes('monitor') || t.includes('host')) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  if (t.includes('startup')) return 'bg-teal-500/15 text-teal-300 border-teal-500/30';
  return 'bg-zinc-800 text-zinc-300 border-zinc-700';
}

/**
 * Returns badge color for HTTP methods.
 */
function getMethodStyle(method: string): string {
  switch (method) {
    case 'GET': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'POST': return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'PUT':
    case 'PATCH': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    case 'DELETE': return 'bg-rose-500/15 text-rose-400 border-rose-500/30';
    default: return 'bg-zinc-800 text-zinc-300 border-zinc-700';
  }
}

/**
 * Returns color style for HTTP status codes.
 */
function getStatusStyle(code: number): string {
  if (code >= 200 && code < 300) return 'text-emerald-400 font-semibold';
  if (code >= 300 && code < 400) return 'text-sky-400 font-semibold';
  if (code >= 400 && code < 500) return 'text-amber-400 font-bold';
  return 'text-rose-400 font-bold bg-rose-500/20 px-1 rounded';
}

/**
 * Safely copies text to clipboard with fallback.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-999999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch {
    ta.remove();
    return false;
  }
}

/**
 * Highlighting component for matching search query fragments.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) return <>{text}</>;
  const q = query.trim();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="bg-amber-400/40 text-amber-200 font-bold px-0.5 rounded">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

export function SystemLogViewer() {
  const [rawText, setRawText] = useState<string>('');
  const [limit, setLimit] = useState<number>(500);
  const [totalLines, setTotalLines] = useState<number | undefined>();
  const [isLive, setIsLive] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState<FilterCategory>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [cleared, setCleared] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef<boolean>(false);

  // Fetch logs from API
  const fetchLogs = useCallback(async (isManual = false) => {
    if (isManual) setIsLoading(true);
    try {
      const data = await api.system.logs(limit);
      setRawText(data.logs || '');
      setTotalLines(data.totalLines);
      if (cleared) setCleared(false);
    } catch (err) {
      console.error('Failed to fetch system logs:', err);
    } finally {
      if (isManual) setIsLoading(false);
    }
  }, [limit, cleared]);

  // Polling interval
  useEffect(() => {
    fetchLogs();
    if (!isLive) return;

    const interval = setInterval(() => {
      fetchLogs();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchLogs, isLive]);

  // Parse lines
  const parsedLines = useMemo(() => {
    if (cleared || !rawText) return [];
    return rawText
      .split('\n')
      .filter(l => l.trim() !== '')
      .map((line, idx) => parseLogLine(line, idx + 1));
  }, [rawText, cleared]);

  // Count totals for filter tabs
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    let sync = 0;
    let proxy = 0;
    let epg = 0;
    let http = 0;
    let system = 0;

    for (const l of parsedLines) {
      if (l.isError) errors++;
      if (l.isWarning) warnings++;
      if (l.category === 'sync') sync++;
      else if (l.category === 'proxy') proxy++;
      else if (l.category === 'epg') epg++;
      else if (l.category === 'http') http++;
      else system++;
    }

    return {
      all: parsedLines.length,
      errors,
      warnings,
      sync,
      proxy,
      epg,
      http,
      system,
    };
  }, [parsedLines]);

  // Filtered lines
  const filteredLines = useMemo(() => {
    let result = parsedLines;

    if (filter === 'errors') {
      result = result.filter(l => l.isError);
    } else if (filter === 'warnings') {
      result = result.filter(l => l.isWarning);
    } else if (filter === 'sync') {
      result = result.filter(l => l.category === 'sync');
    } else if (filter === 'proxy') {
      result = result.filter(l => l.category === 'proxy');
    } else if (filter === 'epg') {
      result = result.filter(l => l.category === 'epg');
    } else if (filter === 'http') {
      result = result.filter(l => l.category === 'http');
    } else if (filter === 'system') {
      result = result.filter(l => l.category === 'system');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(l => l.raw.toLowerCase().includes(q));
    }

    return result;
  }, [parsedLines, filter, searchQuery]);

  // Handle scroll detection
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // User is considered at bottom if within 50px of the end
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  };

  // Auto-scroll when new lines arrive if autoScroll is enabled
  useEffect(() => {
    if (autoScroll && containerRef.current && !isUserScrollingRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  const scrollToBottom = () => {
    setAutoScroll(true);
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

  const handleCopy = async () => {
    const text = filteredLines.map(l => l.raw).join('\n');
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    const text = filteredLines.map(l => l.raw).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gecko-system-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filterTabs: { id: FilterCategory; label: string; count: number; alert?: boolean; warn?: boolean }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'errors', label: 'Errors', count: counts.errors, alert: counts.errors > 0 },
    { id: 'warnings', label: 'Warnings', count: counts.warnings, warn: counts.warnings > 0 },
    { id: 'sync', label: 'Sync & Cron', count: counts.sync },
    { id: 'proxy', label: 'Proxy', count: counts.proxy },
    { id: 'epg', label: 'EPG', count: counts.epg },
    { id: 'http', label: 'HTTP', count: counts.http },
    { id: 'system', label: 'System', count: counts.system },
  ];

  const viewerContent = (
    <div
      className={`flex flex-col bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl transition-all duration-200 ${
        isMaximized
          ? 'fixed inset-4 z-50 p-6'
          : 'relative p-6 h-[680px]'
      }`}
    >
      {/* Top Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-zinc-800/80">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-zinc-100 font-bold">
            <Activity size={18} className="text-emerald-500" />
            <span>System Logs</span>
          </div>

          {/* Live Polling Toggle */}
          <button
            onClick={() => setIsLive(!isLive)}
            title={isLive ? 'Pause live auto-refresh' : 'Resume live auto-refresh'}
            className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${
              isLive
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700'
            }`}
          >
            {isLive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Live</span>
                <Pause size={12} className="opacity-70" />
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <span>Paused</span>
                <Play size={12} className="opacity-70" />
              </>
            )}
          </button>

          {/* Manual Refresh */}
          <button
            onClick={() => fetchLogs(true)}
            disabled={isLoading}
            title="Refresh logs now"
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin text-emerald-400' : ''} />
          </button>

          {/* Buffer Limit Selector */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span>Buffer:</span>
            <select
              value={limit}
              onChange={e => setLimit(parseInt(e.target.value, 10))}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-700 cursor-pointer"
            >
              {LIMIT_OPTIONS.map(opt => (
                <option key={opt} value={opt}>
                  {opt} lines
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Right Action Icons */}
        <div className="flex items-center gap-2">
          {/* Word Wrap Toggle */}
          <button
            onClick={() => setWrapLines(!wrapLines)}
            title={wrapLines ? 'Disable line wrap (horizontal scroll)' : 'Enable word wrap'}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1.5 transition-all ${
              wrapLines
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <WrapText size={14} />
            <span className="hidden sm:inline text-[11px] font-medium">{wrapLines ? 'Wrap: On' : 'Wrap: Off'}</span>
          </button>

          {/* Copy Logs */}
          <button
            onClick={handleCopy}
            disabled={filteredLines.length === 0}
            title="Copy displayed logs to clipboard"
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors flex items-center gap-1.5 disabled:opacity-40"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            <span className="hidden sm:inline text-[11px] font-medium">{copied ? 'Copied' : 'Copy'}</span>
          </button>

          {/* Download Logs */}
          <button
            onClick={handleDownload}
            disabled={filteredLines.length === 0}
            title="Download logs as .txt"
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40"
          >
            <Download size={14} />
          </button>

          {/* Clear Buffer View */}
          <button
            onClick={() => setCleared(true)}
            title="Clear view (temporary)"
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 transition-colors"
          >
            <Trash2 size={14} />
          </button>

          {/* Fullscreen / Maximize */}
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            title={isMaximized ? 'Minimize' : 'Maximize to full window'}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="py-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 border-b border-zinc-800/50">
        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1 md:pb-0">
          {filterTabs.map(tab => {
            const isActive = filter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                  isActive
                    ? 'bg-zinc-100 text-zinc-950 shadow-sm'
                    : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-850 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                <span>{tab.label}</span>
                {tab.alert ? (
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    isActive ? 'bg-rose-600 text-white' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}>
                    {tab.count}
                  </span>
                ) : tab.warn ? (
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    isActive ? 'bg-amber-600 text-white' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  }`}>
                    {tab.count}
                  </span>
                ) : (
                  <span className={`text-[10px] opacity-60 ${isActive ? 'text-zinc-800' : 'text-zinc-500'}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="w-full pl-8 pr-8 py-1.5 bg-zinc-900/90 border border-zinc-800 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Log Output Area */}
      <div className="relative flex-1 min-h-0 mt-3">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className={`h-full overflow-y-auto overflow-x-auto custom-scrollbar font-mono text-[11px] leading-relaxed select-text rounded-2xl bg-zinc-950/60 p-3 border border-zinc-900 ${
            wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
          }`}
        >
          {filteredLines.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2 py-16">
              <Activity size={32} className="opacity-30" />
              <p className="text-xs">
                {searchQuery
                  ? `No logs match "${searchQuery}" in ${filter.toUpperCase()} filter`
                  : filter !== 'all'
                  ? `No log lines matching "${filter}"`
                  : 'Waiting for system activity...'}
              </p>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-xs text-emerald-500 hover:underline"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredLines.map(line => {
                let rowBg = 'hover:bg-zinc-900/60 text-zinc-300 border-l-2 border-transparent';
                if (line.isError) {
                  rowBg = 'bg-rose-950/20 text-rose-200 hover:bg-rose-950/35 border-l-2 border-rose-500';
                } else if (line.isWarning) {
                  rowBg = 'bg-amber-950/20 text-amber-200 hover:bg-amber-950/35 border-l-2 border-amber-500';
                }

                return (
                  <div
                    key={line.id}
                    className={`flex items-start gap-2.5 py-0.5 px-2 rounded-r transition-colors ${rowBg}`}
                  >
                    {/* Line Number */}
                    <span className="text-zinc-600 select-none text-[10px] w-7 text-right shrink-0 pt-0.5">
                      {line.id}
                    </span>

                    {/* Timestamp */}
                    {line.time && (
                      <span className="text-zinc-500 text-[10px] shrink-0 pt-0.5 font-sans tracking-tight">
                        <HighlightedText text={line.time} query={searchQuery} />
                      </span>
                    )}

                    {/* Tag badge (if present) */}
                    {line.tag && (
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded font-sans font-semibold border shrink-0 ${getTagStyle(
                          line.tag
                        )}`}
                      >
                        <HighlightedText text={line.tag} query={searchQuery} />
                      </span>
                    )}

                    {/* HTTP Method badge (if parsed HTTP request) */}
                    {line.httpMethod && (
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded font-sans font-bold border shrink-0 ${getMethodStyle(
                          line.httpMethod
                        )}`}
                      >
                        <HighlightedText text={line.httpMethod} query={searchQuery} />
                      </span>
                    )}

                    {/* HTTP Status Code badge */}
                    {line.httpStatus !== undefined && (
                      <span className={`text-[10px] shrink-0 font-mono ${getStatusStyle(line.httpStatus)}`}>
                        <HighlightedText text={String(line.httpStatus)} query={searchQuery} />
                      </span>
                    )}

                    {/* HTTP Duration */}
                    {line.httpDuration && (
                      <span className="text-[10px] text-zinc-500 shrink-0 font-sans">
                        <HighlightedText text={line.httpDuration} query={searchQuery} />
                      </span>
                    )}

                    {/* Main Log Content */}
                    <span className="flex-1 min-w-0">
                      <HighlightedText text={line.content} query={searchQuery} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Floating "Jump to bottom" Button when auto-scroll is paused */}
        {!autoScroll && filteredLines.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-5 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-semibold rounded-full shadow-xl backdrop-blur transition-all animate-bounce border border-emerald-400/30"
          >
            <ArrowDown size={13} />
            <span>Scroll to bottom</span>
          </button>
        )}
      </div>

      {/* Footer / Status Bar */}
      <div className="pt-3 mt-2 border-t border-zinc-800/80 flex flex-wrap items-center justify-between text-[11px] text-zinc-500 gap-2">
        <div className="flex items-center gap-3">
          <span>
            Showing <strong className="text-zinc-300 font-mono">{filteredLines.length}</strong> of{' '}
            <strong className="text-zinc-300 font-mono">{parsedLines.length}</strong> loaded lines
            {totalLines !== undefined && totalLines > parsedLines.length && (
              <span className="text-zinc-600 ml-1">({totalLines} total on server)</span>
            )}
          </span>
          {searchQuery && (
            <span className="text-amber-400/80">
              Matching &quot;{searchQuery}&quot;
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                autoScroll ? 'bg-emerald-500' : 'bg-zinc-600'
              }`}
            />
            <span className="text-[10px] uppercase tracking-wider">
              {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll PAUSED'}
            </span>
          </div>

          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="text-emerald-400 hover:text-emerald-300 hover:underline text-[10px] font-medium"
            >
              Resume
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {isMaximized && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-40 transition-opacity"
          onClick={() => setIsMaximized(false)}
        />
      )}
      {viewerContent}
    </>
  );
}
