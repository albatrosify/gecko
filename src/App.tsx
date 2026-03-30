import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import api, { isLoggedIn, clearToken } from './api';
import { User as AppUser } from './types';
import { Layout, Dashboard, PlaylistManager, UserManager, Settings, PlaylistEditor, SourceManager, EPGManager, ErrorBoundary } from './components';
import { LogIn, LogOut, LayoutGrid, Library, Users, Settings as SettingsIcon, Database, Tv, UserPlus, Activity, Wifi } from 'lucide-react';
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
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="animate-pulse text-2xl font-light tracking-widest">OPEN IPTV EDITOR</div>
      </div>
    );
  }

  if (!user) {
    return <LoginView onLogin={setUser} />;
  }

  return (
    <ErrorBoundary>
      <Router>
        <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans relative">
          {/* Sidebar */}
          <aside className="absolute left-0 top-0 bottom-0 w-16 hover:w-64 group/sidebar overflow-hidden transition-all duration-300 ease-in-out border-r border-zinc-800 flex flex-col z-50 bg-zinc-950/95 backdrop-blur-xl shadow-2xl">
            <div className="w-64 h-full flex flex-col">
              <div className="p-5 border-b border-zinc-800 h-[73px] flex items-center">
                <h1 className="text-xl font-bold tracking-tighter flex items-center gap-3">
                  <img src={Logo} alt="Gecko" className="w-8 h-8 shrink-0" />
                  <span className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300 whitespace-nowrap hidden sm:block">GECKO</span>
                 <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded ml-2 opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                     v{pkg.version}
                     {import.meta.env.VITE_APP_VERSION && import.meta.env.VITE_APP_VERSION !== 'unknown' && (
                       <span className="ml-1 opacity-50 font-mono text-[8px]">({import.meta.env.VITE_APP_VERSION.slice(0, 7)})</span>
                     )}
                     {COMMIT_HASH !== 'unknown' && (
                       <span className="ml-1 opacity-50 font-mono text-[7px]">({COMMIT_HASH})</span>
                     )}
                   </span>
                </h1>
              </div>
              
              <nav className="flex-1 p-3 space-y-2 mt-2">
                <NavLink to="/" icon={<LayoutGrid size={20} />} label="Dashboard" />
                <NavLink to="/playlists" icon={<Library size={20} />} label="Custom Playlists" />
                <NavLink to="/sources" icon={<Database size={20} />} label="Upstream Sources" />
                <NavLink to="/epgs" icon={<Tv size={20} />} label="EPG Providers" />
                <NavLink to="/settings" icon={<SettingsIcon size={20} />} label="Settings" />
                
                {user.role === 'admin' && (
                  <>
                    <div className="pt-4 pb-2 px-3">
                      <div className="h-px bg-zinc-800 w-full group-hover/sidebar:opacity-100 opacity-0 transition-opacity" />
                    </div>
                    <NavLink to="/users" icon={<Users size={20} />} label="User Management" />
                  </>
                )}
              </nav>

              <div className="p-4 border-t border-zinc-900 mt-auto opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300 bg-zinc-900/10">
                <ProxyBandwidthSidebar />
              </div>

              <div className="p-3 border-t border-zinc-800">
                <div className="px-2 mb-2 text-xs text-zinc-500 truncate opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300">{user.email}</div>
                <button 
                  onClick={handleLogout}
                  className="flex items-center gap-3 w-full p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-all overflow-hidden"
                >
                  <LogOut size={20} className="shrink-0" />
                  <span className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300 whitespace-nowrap text-sm font-medium">Sign Out</span>
                </button>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1 overflow-auto pl-16">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/playlists" element={<PlaylistManager user={user} />} />
              <Route path="/sources" element={<SourceManager user={user} />} />
              <Route path="/epgs" element={<EPGManager user={user} />} />
              <Route path="/settings" element={<Settings user={user} />} />
              <Route path="/playlist/:id" element={<PlaylistEditor user={user} />} />
              {user.role === 'admin' && <Route path="/users" element={<UserManager user={user} />} />}
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
        </div>
      </Router>
    </ErrorBoundary>
  );
}

function ProxyBandwidthSidebar() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await api.proxy.stats();
        setStats(data);
      } catch (err) {
        // Silently ignore: stats are periodically refreshed
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return (
    <div className="space-y-4 animate-pulse">
       <div className="h-4 bg-zinc-800 rounded w-24"></div>
       <div className="h-8 bg-zinc-800 rounded w-full"></div>
    </div>
  );

  const mbps = (stats.currentBps / 1000000).toFixed(2);
  const totalGB = (stats.totalBytes / (1024 * 1024 * 1024)).toFixed(2);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Activity size={14} className="text-emerald-500" />
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Network Info</span>
      </div>
      
      <div className="space-y-3">
        <div>
          <div className="text-[10px] text-zinc-600 font-bold uppercase tracking-tight">Proxy Speed</div>
          <div className="text-lg font-black text-zinc-100 tabular-nums">{mbps} <span className="text-[10px] text-emerald-500">Mbps</span></div>
        </div>
        
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[9px] text-zinc-600 font-bold uppercase tracking-tight">Streams</div>
            <div className="text-sm font-bold text-zinc-200">{stats.activeStreams}</div>
          </div>
          <div>
            <div className="text-[9px] text-zinc-600 font-bold uppercase tracking-tight">Usage</div>
            <div className="text-sm font-bold text-zinc-200">{totalGB} <span className="text-[8px] text-zinc-500">GB</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NavLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link 
      to={to} 
      className="flex items-center gap-3 p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-all group overflow-hidden"
    >
      <span className="group-hover:text-emerald-500 transition-colors shrink-0">{icon}</span>
      <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300">{label}</span>
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
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-md w-full p-8 bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl text-center space-y-8">
        <div className="flex flex-col items-center gap-4">
          <img src={Logo} alt="Gecko" className="w-24 h-24" />
          <div className="space-y-1">
            <h1 className="text-5xl font-black tracking-tighter">GECKO</h1>
            <p className="text-zinc-500 text-sm italic">Multi-Source Playlist Aggregator</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          <div>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
              required
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 focus:border-emerald-500 outline-none transition-all"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 p-4 bg-zinc-100 text-zinc-950 rounded-2xl font-bold hover:bg-emerald-500 hover:text-zinc-100 transition-all disabled:opacity-50"
          >
            {loading ? (
              <span className="animate-pulse">Please wait...</span>
            ) : (
              <>
                {isRegistering ? <UserPlus size={20} /> : <LogIn size={20} />}
                {isRegistering ? 'Create Account' : 'Sign In'}
              </>
            )}
          </button>
        </form>

        <button
          onClick={() => { setIsRegistering(!isRegistering); setError(''); }}
          className="text-sm text-zinc-500 hover:text-emerald-500 transition-colors"
        >
          {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register"}
        </button>

        <p className="text-xs text-zinc-600">
          Manage your IPTV playlists with ease.
        </p>
      </div>
    </div>
  );
}
