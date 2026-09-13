import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SelectedPlaylist = { username: string; password?: string };

type AuthContextType = {
  geckoUrl: string | null;
  jwtToken: string | null;
  selectedPlaylist: SelectedPlaylist | null;
  login: (url: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
  selectPlaylist: (username: string, password?: string) => Promise<void>;
  clearPlaylist: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  const match = trimmed.match(/^(https?:\/\/)([^/?#]+)(.*)$/i);
  if (!match) {
    throw new Error('Invalid URL: scheme must be http or https');
  }
  const protocol = match[1].toLowerCase();
  const hostAndPort = match[2];
  const path = (match[3] || '').replace(/\/+$/, '');
  return `${protocol}${hostAndPort}${path}`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [geckoUrl, setGeckoUrl] = useState<string | null>(null);
  const [jwtToken, setJwtToken] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SelectedPlaylist | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    async function loadAuth() {
      try {
        const [savedUrl, savedToken, savedPlaylist] = await AsyncStorage.multiGet([
          'geckoUrl',
          'jwtToken',
          'selectedPlaylist',
        ]);
        if (savedUrl[1]) setGeckoUrl(savedUrl[1]);
        if (savedToken[1]) setJwtToken(savedToken[1]);
        if (savedPlaylist[1]) setSelectedPlaylist(JSON.parse(savedPlaylist[1]));
      } catch (e) {
        console.error('Failed to load auth credentials', e);
      } finally {
        setIsLoading(false);
      }
    }
    loadAuth();
  }, []);

  const login = async (url: string, token: string) => {
    const cleanUrl = normalizeBaseUrl(url);

    try {
      await AsyncStorage.multiSet([
        ['geckoUrl', cleanUrl],
        ['jwtToken', token],
      ]);
      setGeckoUrl(cleanUrl);
      setJwtToken(token);
    } catch (e) {
      console.error('Failed to save auth credentials', e);
      throw e;
    }
  };

  const logout = async () => {
    try {
      await AsyncStorage.multiRemove(['geckoUrl', 'jwtToken', 'selectedPlaylist']);
    } catch (e) {
      console.error('Failed to remove auth credentials', e);
    } finally {
      setGeckoUrl(null);
      setJwtToken(null);
      setSelectedPlaylist(null);
    }
  };

  const selectPlaylist = async (username: string, password?: string) => {
    const playlist = { username, password };
    try {
      await AsyncStorage.setItem('selectedPlaylist', JSON.stringify(playlist));
    } catch (e) {
      console.error('Failed to save selected playlist', e);
    } finally {
      setSelectedPlaylist(playlist);
    }
  };

  const clearPlaylist = async () => {
    try {
      await AsyncStorage.removeItem('selectedPlaylist');
    } catch (e) {
      console.error('Failed to clear selected playlist', e);
    } finally {
      setSelectedPlaylist(null);
    }
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
