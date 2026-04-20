import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, SafeAreaView, Button } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';

export default function TvScreen() {
  const { geckoUrl, selectedPlaylist } = useAuth();
  const [categories, setCategories] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const api = geckoUrl && selectedPlaylist ? getXtreamApi({
    url: geckoUrl,
    username: selectedPlaylist.username,
    password: selectedPlaylist.password,
  }) : null;

  useEffect(() => {
    if (api) {
      api.getLiveCategories().then(data => {
        setCategories(data);
        setIsLoading(false);
      }).catch(err => {
        console.error('Failed to fetch categories', err);
        setIsLoading(false);
      });
    }
  }, []);

  const handleCategorySelect = async (categoryId: string) => {
    if (!api) return;
    setIsLoading(true);
    setSelectedCategory(categoryId);
    try {
      const data = await api.getLiveStreams(categoryId);
      setChannels(data);
    } catch (err) {
      console.error('Failed to fetch channels', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToCategories = () => {
    setSelectedCategory(null);
    setChannels([]);
  };

  const playChannel = (channel: any) => {
    setActiveStream(channel);
  };

  const closePlayer = () => {
    setActiveStream(null);
  };

  if (activeStream) {
    const streamUrl = `${geckoUrl}/live/${selectedPlaylist?.username}/${selectedPlaylist?.password}/${activeStream.stream_id}.m3u8`;

    return (
      <View style={styles.playerContainer}>
        <Video
          source={{ uri: streamUrl }}
          style={styles.video}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
        />
        <View style={styles.closeButton}>
          <Button title="Close" onPress={closePlayer} color="#fff" />
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{selectedCategory ? 'Channels' : 'Live TV Categories'}</Text>
        {selectedCategory && <Button title="Back" onPress={handleBackToCategories} />}
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" style={styles.center} />
      ) : selectedCategory ? (
        <FlatList
          data={channels}
          keyExtractor={(item) => String(item.stream_id)}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.item} onPress={() => playChannel(item)}>
              <Text>{item.name}</Text>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          data={categories}
          keyExtractor={(item) => String(item.category_id)}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.item} onPress={() => handleCategorySelect(item.category_id)}>
              <Text>{item.category_name}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0' },
  header: { padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: 'bold' },
  item: { padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee' },
  center: { flex: 1, justifyContent: 'center' },
  playerContainer: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  closeButton: { position: 'absolute', top: 40, right: 20, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, padding: 4 },
});
