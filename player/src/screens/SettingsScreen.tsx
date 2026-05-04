import React from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';

export default function SettingsScreen() {
  const { clearPlaylist, logout, selectedPlaylist, geckoUrl } = useAuth();

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>Server:</Text>
        <Text style={styles.value}>{geckoUrl}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Active Playlist User:</Text>
        <Text style={styles.value}>{selectedPlaylist?.username}</Text>
      </View>

      <View style={styles.buttonContainer}>
        <Button title="Switch Playlist" onPress={clearPlaylist} color="#6366f1" />
      </View>

      <View style={styles.buttonContainer}>
        <Button title="Logout" onPress={logout} color="#ef4444" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#09090b', // zinc-950
  },
  section: {
    marginBottom: 20,
    backgroundColor: '#18181b', // zinc-900
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#27272a', // zinc-800
  },
  label: {
    fontSize: 14,
    color: '#a1a1aa', // zinc-400
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fafafa', // zinc-50
  },
  buttonContainer: {
    marginTop: 20,
  },
});
