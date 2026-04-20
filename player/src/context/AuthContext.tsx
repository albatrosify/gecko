import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type AuthContextType = {
  geckoUrl: string | null;
  jwtToken: string | null;
  selectedPlaylist: { username: string; password?: string } | null;
  login: (url: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
  selectPlaylist: (username: string, password?: string) => Promise<void>;
  clearPlaylist: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [geckoUrl, setGeckoUrl] = useState<string | null>(null);
  const [jwtToken, setJwtToken] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<{ username: string; password?: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadAuth() {
      try {
        const url = await AsyncStorage.getItem('geckoUrl');
        const token = await AsyncStorage.getItem('jwtToken');
        const playlistJson = await AsyncStorage.getItem('selectedPlaylist');

        if (url) setGeckoUrl(url);
        if (token) setJwtToken(token);
        if (playlistJson) setSelectedPlaylist(JSON.parse(playlistJson));
      } catch (e) {
        console.error('Failed to load auth state', e);
      } finally {
        setIsLoading(false);
      }
    }
    loadAuth();
  }, []);

  const login = async (url: string, token: string) => {
    // Basic URL cleanup
    const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    await AsyncStorage.setItem('geckoUrl', cleanUrl);
    await AsyncStorage.setItem('jwtToken', token);
    setGeckoUrl(cleanUrl);
    setJwtToken(token);
  };

  const logout = async () => {
    await AsyncStorage.multiRemove(['geckoUrl', 'jwtToken', 'selectedPlaylist']);
    setGeckoUrl(null);
    setJwtToken(null);
    setSelectedPlaylist(null);
  };

  const selectPlaylist = async (username: string, password?: string) => {
    const playlist = { username, password };
    await AsyncStorage.setItem('selectedPlaylist', JSON.stringify(playlist));
    setSelectedPlaylist(playlist);
  };

  const clearPlaylist = async () => {
    await AsyncStorage.removeItem('selectedPlaylist');
    setSelectedPlaylist(null);
  };

  if (isLoading) return null;

  return (
    <AuthContext.Provider value={{ geckoUrl, jwtToken, selectedPlaylist, login, logout, selectPlaylist, clearPlaylist }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
