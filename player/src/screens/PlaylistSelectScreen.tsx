import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Button } from 'react-native';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Playlist = {
  id: string;
  name: string;
  username: string;
  password?: string;
};

export default function PlaylistSelectScreen() {
  const insets = useSafeAreaInsets();
  const { geckoUrl, jwtToken, selectPlaylist, logout } = useAuth();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchPlaylists = async (signal?: AbortSignal) => {
    if (!geckoUrl || !jwtToken) {
      setIsLoading(false);
      return;
    }
    try {
      setIsLoading(true);
      setFetchError(null);
      const res = await axios.get<Playlist[]>(`${geckoUrl}/api/playlists`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
        signal,
      });
      setPlaylists(Array.isArray(res.data) ? res.data : []);
    } catch (e: unknown) {
      if (axios.isCancel(e) || (e instanceof Error && e.name === 'CanceledError')) {
        return;
      }
      const message = axios.isAxiosError(e)
        ? e.response?.data?.error || e.message
        : 'Failed to load playlists';
      setFetchError(message);
      Alert.alert('Error', message);
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!geckoUrl || !jwtToken) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    fetchPlaylists(controller.signal);
    return () => {
      controller.abort();
    };
  }, [geckoUrl, jwtToken]);

  const handleRetry = () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    fetchPlaylists(controller.signal);
  };

  const handleSelect = async (item: Playlist) => {
    if (!item?.username) {
      Alert.alert('Error', 'Invalid playlist configuration: missing username.');
      return;
    }
    try {
      await selectPlaylist(item.username, item.password || '');
    } catch (e) {
      Alert.alert('Error', 'Failed to select playlist.');
    }
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: Math.max(insets.top, 20) }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Select a Playlist</Text>
        <Button title="Logout" onPress={logout} color="#ef4444" />
      </View>
      {fetchError && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{fetchError}</Text>
          <Button title="Retry" onPress={handleRetry} color="#6366f1" />
        </View>
      )}
      <FlatList
        data={playlists}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => handleSelect(item)}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.user}>User: {item.username}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No playlists found.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#09090b', // zinc-950
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fafafa', // zinc-50
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#09090b',
  },
  card: {
    padding: 16,
    borderWidth: 1,
    borderColor: '#27272a', // zinc-800
    borderRadius: 8,
    marginBottom: 12,
    backgroundColor: '#18181b', // zinc-900
  },
  name: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
    color: '#fafafa',
  },
  user: {
    color: '#a1a1aa', // zinc-400
  },
  empty: {
    textAlign: 'center',
    color: '#a1a1aa',
    marginTop: 40,
  },
  errorContainer: {
    marginBottom: 16,
  },
  errorText: {
    color: '#ef4444',
    textAlign: 'center',
    marginBottom: 8,
  },
});
