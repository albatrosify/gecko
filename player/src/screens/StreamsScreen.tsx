import React, { useEffect, useState, useMemo, useLayoutEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';

export default function StreamsScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { type, categoryId, categoryName } = route.params;

  const { geckoUrl, selectedPlaylist } = useAuth();
  const [items, setItems] = useState<any[]>([]);
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
    navigation.setOptions({ title: categoryName });
  }, [navigation, categoryName]);

  useEffect(() => {
    if (!api) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    let isCancelled = false;

    let fetchPromise;
    if (type === 'live') fetchPromise = api.getLiveStreams(categoryId);
    else if (type === 'vod') fetchPromise = api.getVodStreams(categoryId);
    else fetchPromise = api.getSeries(categoryId);

    fetchPromise
      .then(data => {
        if (!isCancelled) setItems(Array.isArray(data) ? data : []);
      })
      .catch(err => {
        if (isCancelled) return;
        console.error('Failed to fetch items', err);
        Alert.alert('Error', 'Failed to load streams.');
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [api, type, categoryId]);

  const handleItemSelect = (item: any) => {
    if (type === 'series') {
      navigation.navigate('SeriesInfo', { seriesId: item.series_id, seriesName: item.name });
    } else {
      if (!geckoUrl || !selectedPlaylist?.username) {
        Alert.alert('Error', 'Missing playlist credentials. Please sign in again.');
        return;
      }

      let ext = 'm3u8';
      let idProp = 'stream_id';
      let pathType = 'live';

      if (type === 'vod') {
        ext = item.container_extension || 'mp4';
        pathType = 'movie';
      }

      const streamId = item[idProp];
      if (!streamId) {
        Alert.alert('Error', 'Invalid stream identifier.');
        return;
      }

      const streamUrl = `${geckoUrl}/${pathType}/${encodeURIComponent(selectedPlaylist.username)}/${encodeURIComponent(selectedPlaylist.password || '')}/${encodeURIComponent(streamId)}.${encodeURIComponent(ext)}`;

      // Navigate to the global Player modal
      navigation.navigate('Player', { streamUrl, title: item.name });
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
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.stream_id || item.series_id)}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() => handleItemSelect(item)}
          >
            <Text style={styles.itemText}>{item.name}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
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
  item: {
    padding: 16,
    backgroundColor: '#18181b', // zinc-900
    borderBottomWidth: 1,
    borderBottomColor: '#27272a', // zinc-800
  },
  itemText: {
    fontSize: 16,
    color: '#fafafa', // zinc-50
  },
});
