import React, { useEffect, useState } from 'react';
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

  useEffect(() => {
    fetchPlaylists();
  }, []);

  const fetchPlaylists = async () => {
    try {
      const res = await axios.get(`${geckoUrl}/api/playlists`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
      setPlaylists(res.data);
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelect = (item: Playlist) => {
    selectPlaylist(item.username, item.password);
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
});
