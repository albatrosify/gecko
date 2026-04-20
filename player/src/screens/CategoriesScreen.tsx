import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { getXtreamApi } from '../api/xtream';

export default function CategoriesScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { type } = route.params; // 'live' | 'vod' | 'series'

  const { geckoUrl, selectedPlaylist } = useAuth();
  const [categories, setCategories] = useState<any[]>([]);
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

  useEffect(() => {
    if (!api) return;

    setIsLoading(true);
    let fetchPromise;
    if (type === 'live') fetchPromise = api.getLiveCategories();
    else if (type === 'vod') fetchPromise = api.getVodCategories();
    else fetchPromise = api.getSeriesCategories();

    fetchPromise
      .then(data => setCategories(data))
      .catch(err => {
        console.error('Failed to fetch categories', err);
        Alert.alert('Error', `Failed to load ${type} categories.`);
      })
      .finally(() => setIsLoading(false));
  }, [api, type]);

  const handleCategorySelect = (categoryId: string, categoryName: string) => {
    navigation.navigate('Streams', { type, categoryId, categoryName });
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
        data={categories}
        keyExtractor={(item) => String(item.category_id)}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() => handleCategorySelect(item.category_id, item.category_name)}
          >
            <Text style={styles.itemText}>{item.category_name}</Text>
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
