import { useEffect, useState, useMemo } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import api, { isLoggedIn, clearToken } from './api';
import { User as AppUser } from './types';
import {
  Dashboard,
  DvrManager,
  PlaylistManager,
  UserManager,
  Settings,
  PlaylistEditor,
  SourceManager,
  EPGManager,
  ErrorBoundary,
} from './components';
import { TrafficView } from './components/TrafficView';
import {
  LogIn,
  LogOut,
  LayoutGrid,
  Library,
  Users,
  Settings as SettingsIcon,
  Database,
  Tv,
  UserPlus,
  Activity,
  Radio,
  BarChart3,
  PanelLeft,
  MoreHorizontal,
  X,
  ChevronRight,
  Wifi,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Logo from './assets/logo.png';
import pkg from '../package.json';

// Get commit hash from environment variable or fallback to 'unknown'
const COMMIT_HASH = import.meta.env.VITE_APP_COMMIT_HASH || 'unknown';

export default function App() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      setLoading(false);
      return;
    }
    api.auth.me()
      .then(u => setUser(u))
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    api.auth.logout();
    setUser(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0c0d0e] text-zinc-100">
        <div className="flex flex-col items-center gap-4">
          <img src={Logo} alt="Gecko" className="w-16 h-16 animate-pulse" />
          <div className="text-sm font-medium tracking-widest text-zinc-400 uppercase">GECKO</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView onLogin={setUser} />;
  }

  return (
    <ErrorBoundary>
      <Router>
        <AppLayout user={user} onLogout={handleLogout} />
      </Router>
    </ErrorBoundary>
  );
}

function AppLayout({ user, onLogout }: { user: AppUser; onLogout: () => void }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('gecko_sidebar_collapsed') === 'true';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [proxyStats, setProxyStats] = useState<any>(null);

  // Toggle and persist desktop sidebar collapsed state
  const toggleSidebar = () => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('gecko_sidebar_collapsed', String(next));
      return next;
    });
  };

  // Keyboard shortcut: Cmd+\ or Ctrl+\ toggles sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Poll proxy stats for sidebar and mobile indicators
  useEffect(() => {
    let isMounted = true;
    const fetchStats = async () => {
      try {
        const data = await api.proxy.stats();
        if (isMounted) setProxyStats(data);
      } catch {
        // Silently ignore periodic refresh errors
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Close mobile drawer upon route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Page title resolution
  const currentTitle = useMemo(() => {
    const path = location.pathname;
    if (path === '/') return 'Übersicht';
    if (path === '/traffic') return 'Traffic & Daten';
    if (path === '/dvr') return 'DVR / Aufnahmen';
    if (path === '/playlists') return 'Playlists';
    if (path === '/sources') return 'Upstream Quellen';
    if (path === '/epgs') return 'EPG Provider';
    if (path === '/settings') return 'Einstellungen';
    if (path === '/users') return 'Benutzerverwaltung';
    if (path.startsWith('/playlist/')) return 'Playlist bearbeiten';
    return 'GECKO';
  }, [location.pathname]);

  const mbps = proxyStats ? (proxyStats.currentBps / 1000000).toFixed(1) : '0.0';
  const hasActiveStreams = proxyStats?.activeStreams > 0;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0c0d0e] text-[#f5f5f7]">
      {/* ────────────────────────────────────────────────────────── */}
      {/* DESKTOP macOS-STYLE ADAPTABLE SIDEBAR                     */}
      {/* ────────────────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex flex-col border-r border-white/[0.08] apple-glass-sidebar transition-all duration-300 ease-out z-30 shrink-0 ${
          collapsed ? 'w-[72px]' : 'w-64'
        }`}
      >
        {/* Sidebar Header */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-white/[0.06]">
          <div className="flex items-center gap-3 overflow-hidden">
            <img src={Logo} alt="Gecko" className="w-8 h-8 rounded-lg shrink-0 shadow-sm" />
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm tracking-tight text-white truncate">GECKO</span>
                  <span className="text-[10px] bg-emerald-500/15 text-emerald-400 font-mono px-1.5 py-0.2 rounded-md font-medium">
                    v{pkg.version}
                  </span>
                </div>
                {import.meta.env.VITE_APP_VERSION && import.meta.env.VITE_APP_VERSION !== 'unknown' && (
                  <span className="text-[9px] text-zinc-500 font-mono truncate">
                    {import.meta.env.VITE_APP_VERSION.slice(0, 7)}
                  </span>
                )}
              </div>
            )}
          </div>

          <button
            onClick={toggleSidebar}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] rounded-lg transition-colors cursor-pointer"
            title={collapsed ? 'Seitenleiste einblenden (Cmd+\\)' : 'Seitenleiste einklappen (Cmd+\\)'}
            aria-label="Toggle Sidebar"
          >
            <PanelLeft size={17} />
          </button>
        </div>

        {/* Sidebar Navigation */}
        <nav className="flex-1 p-2.5 space-y-4 overflow-y-auto custom-scrollbar">
          {/* Section: Monitor */}
          <div className="space-y-1">
            {!collapsed && (
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                Monitor
              </div>
            )}
            <DesktopNavLink
              to="/"
              icon={<LayoutGrid size={18} />}
              label="Übersicht"
              active={location.pathname === '/'}
              collapsed={collapsed}
              badge={hasActiveStreams ? `${proxyStats.activeStreams}` : undefined}
            />
            <DesktopNavLink
              to="/traffic"
              icon={<BarChart3 size={18} />}
              label="Traffic & Daten"
              active={location.pathname === '/traffic'}
              collapsed={collapsed}
            />
          </div>

          {/* Section: Library */}
          <div className="space-y-1">
            {!collapsed && (
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                Mediathek
              </div>
            )}
            <DesktopNavLink
              to="/playlists"
              icon={<Library size={18} />}
              label="Playlists"
              active={location.pathname.startsWith('/playlist')}
              collapsed={collapsed}
            />
            <DesktopNavLink
              to="/dvr"
              icon={<Radio size={18} />}
              label="DVR Aufnahmen"
              active={location.pathname === '/dvr'}
              collapsed={collapsed}
            />
          </div>

          {/* Section: System & Config */}
          <div className="space-y-1">
            {!collapsed && (
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                Verwaltung
              </div>
            )}
            <DesktopNavLink
              to="/sources"
              icon={<Database size={18} />}
              label="Upstream Quellen"
              active={location.pathname === '/sources'}
              collapsed={collapsed}
            />
            <DesktopNavLink
              to="/epgs"
              icon={<Tv size={18} />}
              label="EPG Provider"
              active={location.pathname === '/epgs'}
              collapsed={collapsed}
            />
            <DesktopNavLink
              to="/settings"
              icon={<SettingsIcon size={18} />}
              label="Einstellungen"
              active={location.pathname === '/settings'}
              collapsed={collapsed}
            />
            {user.role === 'admin' && (
              <DesktopNavLink
                to="/users"
                icon={<Users size={18} />}
                label="Benutzer"
                active={location.pathname === '/users'}
                collapsed={collapsed}
              />
            )}
          </div>
        </nav>

        {/* Sidebar Speed Glance Widget */}
        <div className="p-2 border-t border-white/[0.06]">
          {collapsed ? (
            <Link
              to="/traffic"
              className="flex items-center justify-center p-2.5 text-zinc-400 hover:text-emerald-400 hover:bg-white/[0.04] rounded-xl transition-all"
              title={`Netzwerk: ${mbps} Mbps · ${proxyStats?.activeStreams || 0} aktive Streams`}
            >
              <div className="relative">
                <Activity size={18} />
                {hasActiveStreams && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                )}
              </div>
            </Link>
          ) : (
            <Link
              to="/traffic"
              className="block p-3 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.04] transition-all group"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Activity size={12} className="text-emerald-400" />
                  Live Bandbreite
                </span>
                <span className="text-xs font-semibold text-zinc-300 group-hover:text-emerald-400 transition-colors">
                  Details →
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-bold text-white tabular-nums tracking-tight">
                  {mbps} <span className="text-xs font-normal text-emerald-400">Mbps</span>
                </span>
                <span className="text-[11px] text-zinc-400">
                  {proxyStats?.activeStreams || 0} {proxyStats?.activeStreams === 1 ? 'Stream' : 'Streams'}
                </span>
              </div>
            </Link>
          )}
        </div>

        {/* Sidebar Footer User Info */}
        <div className="p-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          {!collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-8 h-8 rounded-full bg-white/[0.08] border border-white/[0.1] flex items-center justify-center font-semibold text-xs text-white shrink-0">
                {user.email.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-white truncate" title={user.email}>
                  {user.email}
                </div>
                <div className="text-[10px] text-zinc-500 capitalize">{user.role}</div>
              </div>
              <button
                onClick={onLogout}
                className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                title="Abmelden"
                aria-label="Abmelden"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button
              onClick={onLogout}
              className="w-full flex items-center justify-center p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              title="Abmelden"
              aria-label="Abmelden"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
      </aside>

      {/* ────────────────────────────────────────────────────────── */}
      {/* MAIN CONTAINER: Top Bar (Mobile) + Scrollable View + Tab Bar*/}
      {/* ────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Mobile Top Navigation Bar */}
        <header className="md:hidden apple-glass-topbar sticky top-0 z-30 pt-safe px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <img src={Logo} alt="Gecko" className="w-7 h-7 rounded-lg" />
            <span className="font-bold text-base tracking-tight text-white">{currentTitle}</span>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/traffic"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/[0.08] text-xs font-medium text-zinc-200"
            >
              <span className={`w-2 h-2 rounded-full ${hasActiveStreams ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-500'}`} />
              <span className="tabular-nums font-mono text-[11px]">{mbps}M</span>
            </Link>

            <button
              onClick={() => setMobileMenuOpen(true)}
              className="p-1.5 text-zinc-300 hover:text-white bg-white/[0.06] border border-white/[0.08] rounded-full active:scale-95 transition-all"
              aria-label="Mehr Menü öffnen"
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        </header>

        {/* Scrollable View Area */}
        <main className="flex-1 overflow-auto custom-scrollbar pb-safe-nav md:pb-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/traffic" element={<TrafficView user={user} />} />
            <Route path="/dvr" element={<DvrManager />} />
            <Route path="/playlists" element={<PlaylistManager />} />
            <Route path="/sources" element={<SourceManager />} />
            <Route path="/epgs" element={<EPGManager />} />
            <Route path="/settings" element={<Settings user={user} />} />
            <Route path="/playlist/:id" element={<PlaylistEditor />} />
            {user.role === 'admin' && <Route path="/users" element={<UserManager user={user} />} />}
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>

        {/* Mobile Floating Liquid Glass Bottom Tab Bar */}
        <nav className="md:hidden apple-glass-tabbar fixed bottom-0 left-0 right-0 z-40 pb-safe pt-1.5 px-3 flex items-center justify-around">
          <MobileTabItem
            to="/"
            icon={<LayoutGrid size={20} />}
            label="Übersicht"
            active={location.pathname === '/'}
          />
          <MobileTabItem
            to="/playlists"
            icon={<Library size={20} />}
            label="Playlists"
            active={location.pathname.startsWith('/playlist')}
          />
          <MobileTabItem
            to="/dvr"
            icon={<Radio size={20} />}
            label="DVR"
            active={location.pathname === '/dvr'}
          />
          <MobileTabItem
            to="/sources"
            icon={<Database size={20} />}
            label="Quellen"
            active={location.pathname === '/sources'}
          />
          <button
            onClick={() => setMobileMenuOpen(true)}
            className={`flex flex-col items-center justify-center min-w-[56px] py-1 text-center transition-colors min-h-[44px] ${
              ['/traffic', '/epgs', '/settings', '/users'].includes(location.pathname)
                ? 'text-emerald-400 font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <MoreHorizontal size={20} />
            <span className="text-[10px] mt-0.5 tracking-tight">Mehr</span>
          </button>
        </nav>
      </div>

      {/* ────────────────────────────────────────────────────────── */}
      {/* MOBILE "MEHR" ACTION SHEET / DRAWER                        */}
      {/* ────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center md:hidden">
            {/* Scrim */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />

            {/* Bottom Sheet */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 300 }}
              className="relative w-full max-w-lg bg-[#141618] border-t border-white/[0.1] rounded-t-3xl shadow-2xl p-5 pb-safe z-10 space-y-4 max-h-[85vh] overflow-y-auto custom-scrollbar"
            >
              {/* Drag handle */}
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto" />

              <div className="flex items-center justify-between pt-1">
                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Menü & Verwaltung</h3>
                  <p className="text-xs text-zinc-400">Erweiterte Werkzeuge & Systemoptionen</p>
                </div>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-1.5 rounded-full bg-white/[0.08] text-zinc-400 hover:text-white"
                  aria-label="Schließen"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Grouped Inset List (iOS Style) */}
              <div className="rounded-2xl bg-white/[0.04] border border-white/[0.07] divide-y divide-white/[0.06] overflow-hidden">
                <MobileDrawerRow
                  to="/traffic"
                  icon={<BarChart3 size={18} className="text-emerald-400" />}
                  label="Traffic & Datenverbrauch"
                  detail={`${mbps} Mbps`}
                />
                <MobileDrawerRow
                  to="/epgs"
                  icon={<Tv size={18} className="text-blue-400" />}
                  label="EPG Provider & Guide"
                />
                <MobileDrawerRow
                  to="/settings"
                  icon={<SettingsIcon size={18} className="text-purple-400" />}
                  label="Einstellungen & Scans"
                />
                {user.role === 'admin' && (
                  <MobileDrawerRow
                    to="/users"
                    icon={<Users size={18} className="text-amber-400" />}
                    label="Benutzerverwaltung"
                  />
                )}
              </div>

              {/* Account Card */}
              <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-between">
                <div className="min-w-0 pr-2">
                  <div className="text-xs font-semibold text-white truncate">{user.email}</div>
                  <div className="text-[10px] text-zinc-400 capitalize">{user.role} · v{pkg.version}</div>
                </div>
                <button
                  onClick={onLogout}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white text-xs font-medium transition-all min-h-[38px]"
                >
                  <LogOut size={14} />
                  <span>Abmelden</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DesktopNavLink({
  to,
  icon,
  label,
  active,
  collapsed,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  badge?: string;
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all group relative min-h-[38px] ${
        active
          ? 'bg-white/[0.1] text-white shadow-sm border border-white/[0.08]'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
      }`}
      title={collapsed ? label : undefined}
    >
      <span
        className={`shrink-0 transition-colors ${
          active ? 'text-emerald-400' : 'text-zinc-400 group-hover:text-zinc-200'
        }`}
      >
        {icon}
      </span>

      {!collapsed && (
        <span className="truncate flex-1 tracking-tight">{label}</span>
      )}

      {!collapsed && badge && (
        <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 text-[10px] font-bold font-mono">
          {badge}
        </span>
      )}

      {collapsed && badge && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-500" />
      )}
    </Link>
  );
}

function MobileTabItem({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      className={`flex flex-col items-center justify-center min-w-[56px] py-1 text-center transition-colors min-h-[44px] ${
        active ? 'text-emerald-400 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {icon}
      <span className="text-[10px] mt-0.5 tracking-tight">{label}</span>
    </Link>
  );
}

function MobileDrawerRow({
  to,
  icon,
  label,
  detail,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between p-3.5 hover:bg-white/[0.05] transition-colors active:bg-white/[0.08] min-h-[48px]"
    >
      <div className="flex items-center gap-3">
        <div className="p-1 rounded-lg bg-white/[0.06]">{icon}</div>
        <span className="text-sm font-medium text-white">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-zinc-400">
        {detail && <span className="font-mono text-zinc-300">{detail}</span>}
        <ChevronRight size={16} className="text-zinc-500" />
      </div>
    </Link>
  );
}

function LoginView({ onLogin }: { onLogin: (user: AppUser) => void }) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = isRegistering
        ? await api.auth.register(email, password)
        : await api.auth.login(email, password);
      onLogin(user);
    } catch (err: any) {
      setError(err.message || 'Authentifizierung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0c0d0e] p-4 text-[#f5f5f7]">
      <div className="w-full max-w-sm apple-glass p-8 rounded-3xl border border-white/[0.09] shadow-2xl space-y-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="p-3 bg-white/[0.06] border border-white/[0.08] rounded-2xl shadow-inner">
            <img src={Logo} alt="Gecko" className="w-16 h-16 drop-shadow-md" />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">GECKO</h1>
            <p className="text-xs text-zinc-400 mt-0.5">IPTV Playlist Aggregator & Proxy</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-left">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider pl-1">
              E-Mail
            </label>
            <input
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-3.5 py-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 transition-all min-h-[44px]"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider pl-1">
              Passwort
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-3.5 py-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 transition-all min-h-[44px]"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs text-center font-medium">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl shadow-[0_4px_16px_rgba(48,209,88,0.25)] active:scale-[0.98] transition-all disabled:opacity-50 min-h-[44px] cursor-pointer mt-2"
          >
            {loading ? (
              <span className="text-xs font-semibold">Bitte warten...</span>
            ) : (
              <>
                {isRegistering ? <UserPlus size={18} /> : <LogIn size={18} />}
                <span className="text-sm">{isRegistering ? 'Account erstellen' : 'Anmelden'}</span>
              </>
            )}
          </button>
        </form>

        <button
          onClick={() => {
            setIsRegistering(!isRegistering);
            setError('');
          }}
          className="text-xs text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer"
        >
          {isRegistering
            ? 'Bereits registriert? Hier anmelden'
            : 'Noch kein Account? Jetzt registrieren'}
        </button>
      </div>
    </div>
  );
}
