import React from 'react';
import { View, Text, Button, StyleSheet, SafeAreaView } from 'react-native';
import { useAuth } from '../context/AuthContext';

export default function SettingsScreen() {
  const { clearPlaylist, logout, selectedPlaylist, geckoUrl } = useAuth();

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.label}>Server:</Text>
        <Text style={styles.value}>{geckoUrl}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Active Playlist User:</Text>
        <Text style={styles.value}>{selectedPlaylist?.username}</Text>
      </View>

      <View style={styles.buttonContainer}>
        <Button title="Switch Playlist" onPress={clearPlaylist} />
      </View>

      <View style={styles.buttonContainer}>
        <Button title="Logout" onPress={logout} color="red" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 30,
    marginTop: 20,
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    color: '#666',
    marginBottom: 4,
  },
  value: {
    fontSize: 18,
    fontWeight: '500',
  },
  buttonContainer: {
    marginTop: 20,
  },
});
