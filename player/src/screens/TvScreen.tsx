import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, SafeAreaView, Button } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function TvScreen() {
  const insets = useSafeAreaInsets();
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

  const streamUrl = activeStream ? `${geckoUrl}/live/${selectedPlaylist?.username}/${selectedPlaylist?.password}/${activeStream.stream_id}.m3u8` : '';
  const player = useVideoPlayer(streamUrl, player => {
    if (activeStream) {
        player.loop = false;
        player.play();
    }
  });

  if (activeStream) {
    return (
      <View style={[styles.playerContainer, { paddingTop: insets.top }]}>
        <VideoView
          player={player}
          style={styles.video}
          allowsFullscreen
          allowsPictureInPicture
        />
        <View style={styles.closeButton}>
          <Button title="Close" onPress={closePlayer} color="#fff" />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
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
    </View>
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
