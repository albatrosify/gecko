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
    if (!api) return;

    setIsLoading(true);
    api.getSeriesInfo(seriesId)
      .then(data => setSeriesInfo(data))
      .catch(err => {
        console.error('Failed to fetch series info', err);
        Alert.alert('Error', 'Failed to load series details.');
      })
      .finally(() => setIsLoading(false));
  }, [api, seriesId]);

  const handleEpisodeSelect = (episode: any) => {
    const ext = episode.container_extension || 'mp4';
    const streamUrl = `${geckoUrl}/series/${selectedPlaylist?.username}/${selectedPlaylist?.password}/${episode.id}.${ext}`;

    navigation.navigate('Player', { streamUrl, title: episode.title });
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  if (!seriesInfo || !seriesInfo.episodes) {
    return (
      <View style={styles.center}>
        <Text style={styles.itemText}>No episodes found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {Object.keys(seriesInfo.episodes).map((season: string) => (
        <View key={season}>
          <View style={styles.seasonHeader}>
            <Text style={styles.seasonTitle}>Season {season}</Text>
          </View>
          {seriesInfo.episodes[season].map((ep: any) => (
            <TouchableOpacity
              key={ep.id}
              style={styles.item}
              onPress={() => handleEpisodeSelect(ep)}
            >
              <Text style={styles.itemText}>Episode {ep.episode_num}: {ep.title}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ))}
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
