import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Button } from 'react-native';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

type Playlist = {
  id: string;
  name: string;
  username: string;
  password?: string;
};

export default function PlaylistSelectScreen() {
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
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select a Playlist</Text>
        <Button title="Logout" onPress={logout} color="red" />
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
    backgroundColor: '#fff',
    paddingTop: 60,
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
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    padding: 16,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    marginBottom: 12,
    backgroundColor: '#f9f9f9',
  },
  name: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  user: {
    color: '#666',
  },
  empty: {
    textAlign: 'center',
    color: '#999',
    marginTop: 40,
  },
});
