import React, { useEffect, useState, useMemo, useLayoutEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';

export default function SeriesInfoScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { seriesId, seriesName } = route.params;

  const { geckoUrl, selectedPlaylist } = useAuth();
  const [seriesInfo, setSeriesInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  const api = useMemo(() => {
    if (geckoUrl && selectedPlaylist) {
      return getXtreamApi({
        url: geckoUrl,
        username: selectedPlaylist.username,
        password: selectedPlaylist.password,
      });
    }
    return null;
  }, [geckoUrl, selectedPlaylist]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: seriesName });
  }, [navigation, seriesName]);

  useEffect(() => {
    if (!api) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    let isCancelled = false;

    api.getSeriesInfo(seriesId)
      .then(data => {
        if (!isCancelled) setSeriesInfo(data);
      })
      .catch(err => {
        if (isCancelled) return;
        console.error('Failed to fetch series info', err);
        Alert.alert('Error', 'Failed to load series details.');
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [api, seriesId]);

  const handleEpisodeSelect = (episode: any) => {
    if (!geckoUrl || !selectedPlaylist?.username) {
      Alert.alert('Error', 'Missing playlist credentials. Please sign in again.');
      return;
    }

    const ext = episode.container_extension || 'mp4';
    const episodeId = episode.id;
    if (!episodeId) {
      Alert.alert('Error', 'Invalid episode identifier.');
      return;
    }

    const streamUrl = `${geckoUrl}/series/${encodeURIComponent(selectedPlaylist.username)}/${encodeURIComponent(selectedPlaylist.password || '')}/${encodeURIComponent(episodeId)}.${encodeURIComponent(ext)}`;

    navigation.navigate('Player', { streamUrl, title: episode.title });
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  if (!seriesInfo || !seriesInfo.episodes || typeof seriesInfo.episodes !== 'object') {
    return (
      <View style={styles.center}>
        <Text style={styles.itemText}>No episodes found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {Object.keys(seriesInfo.episodes).map((season: string) => {
        const episodeList = Array.isArray(seriesInfo.episodes[season]) ? seriesInfo.episodes[season] : [];
        if (!episodeList.length) return null;

        return (
          <View key={season}>
            <View style={styles.seasonHeader}>
              <Text style={styles.seasonTitle}>Season {season}</Text>
            </View>
            {episodeList.map((ep: any, index: number) => (
              <TouchableOpacity
                key={String(ep.id ?? `${season}-${ep.episode_num ?? index}`)}
                style={styles.item}
                onPress={() => handleEpisodeSelect(ep)}
              >
                <Text style={styles.itemText}>Episode {ep.episode_num}: {ep.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b', // zinc-950
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#09090b',
  },
  seasonHeader: {
    padding: 12,
    backgroundColor: '#27272a', // zinc-800
  },
  seasonTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fafafa',
  },
  item: {
    padding: 16,
    backgroundColor: '#18181b', // zinc-900
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  itemText: {
    fontSize: 16,
    color: '#fafafa',
  },
});
