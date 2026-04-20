import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, SafeAreaView, Button, ScrollView } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function SeriesScreen() {
  const insets = useSafeAreaInsets();
  const { geckoUrl, selectedPlaylist } = useAuth();
  const [categories, setCategories] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const [activeSeries, setActiveSeries] = useState<any | null>(null);
  const [seriesInfo, setSeriesInfo] = useState<any | null>(null);
  const [activeStream, setActiveStream] = useState<any | null>(null);

  const [isLoading, setIsLoading] = useState(true);

  const api = geckoUrl && selectedPlaylist ? getXtreamApi({
    url: geckoUrl,
    username: selectedPlaylist.username,
    password: selectedPlaylist.password,
  }) : null;

  useEffect(() => {
    if (api) {
      api.getSeriesCategories().then(data => {
        setCategories(data);
        setIsLoading(false);
      }).catch(err => {
        console.error('Failed to fetch Series categories', err);
        setIsLoading(false);
      });
    }
  }, []);

  const handleCategorySelect = async (categoryId: string) => {
    if (!api) return;
    setIsLoading(true);
    setSelectedCategory(categoryId);
    try {
      const data = await api.getSeries(categoryId);
      setSeries(data);
    } catch (err) {
      console.error('Failed to fetch series list', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSeriesSelect = async (seriesItem: any) => {
    if (!api) return;
    setIsLoading(true);
    setActiveSeries(seriesItem);
    try {
      const data = await api.getSeriesInfo(seriesItem.series_id);
      setSeriesInfo(data);
    } catch (err) {
      console.error('Failed to fetch series info', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToCategories = () => {
    setSelectedCategory(null);
    setSeries([]);
  };

  const handleBackToSeries = () => {
    setActiveSeries(null);
    setSeriesInfo(null);
  };

  const playEpisode = (episode: any) => {
    setActiveStream(episode);
  };

  const closePlayer = () => {
    setActiveStream(null);
  };

  const ext = activeStream?.container_extension || 'mp4';
  const streamUrl = activeStream ? `${geckoUrl}/series/${selectedPlaylist?.username}/${selectedPlaylist?.password}/${activeStream.id}.${ext}` : '';
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
        <Text style={styles.title}>
          {activeSeries ? activeSeries.name : selectedCategory ? 'Series' : 'Series Categories'}
        </Text>
        {activeSeries ? (
          <Button title="Back" onPress={handleBackToSeries} />
        ) : selectedCategory ? (
          <Button title="Back" onPress={handleBackToCategories} />
        ) : null}
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" style={styles.center} />
      ) : activeSeries && seriesInfo ? (
        <ScrollView style={styles.content}>
          {Object.keys(seriesInfo.episodes || {}).map((season: string) => (
            <View key={season}>
              <Text style={styles.seasonTitle}>Season {season}</Text>
              {seriesInfo.episodes[season].map((ep: any) => (
                <TouchableOpacity key={ep.id} style={styles.item} onPress={() => playEpisode(ep)}>
                  <Text>Episode {ep.episode_num}: {ep.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
      ) : selectedCategory ? (
        <FlatList
          data={series}
          keyExtractor={(item) => String(item.series_id)}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.item} onPress={() => handleSeriesSelect(item)}>
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
  title: { fontSize: 20, fontWeight: 'bold', flex: 1 },
  item: { padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee' },
  seasonTitle: { padding: 16, fontSize: 18, fontWeight: 'bold', backgroundColor: '#e0e0e0' },
  center: { flex: 1, justifyContent: 'center' },
  content: { flex: 1 },
  playerContainer: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  closeButton: { position: 'absolute', top: 40, right: 20, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, padding: 4 },
});
