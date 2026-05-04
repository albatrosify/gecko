import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    if (!url || !email || !password) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    try {
      setIsLoading(true);
      const res = await axios.post(`${cleanUrl}/api/auth/login`, {
        email,
        password,
      });

      if (res.data && res.data.token) {
        await login(cleanUrl, res.data.token);
      } else {
        Alert.alert('Error', 'Invalid response from server');
      }
    } catch (e: any) {
      Alert.alert('Login Failed', e.response?.data?.error || e.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: Math.max(insets.top, 20) }]}>
      <Text style={styles.title}>Gecko Player</Text>
      <TextInput
        style={styles.input}
        placeholder="Server URL (e.g. http://192.168.1.100:3000)"
        placeholderTextColor="#a1a1aa"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        keyboardType="url"
      />
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#a1a1aa"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#a1a1aa"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      {isLoading ? (
        <ActivityIndicator size="large" color="#6366f1" />
      ) : (
        <View style={styles.buttonContainer}>
          <Button title="Login" onPress={handleLogin} color="#6366f1" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    backgroundColor: '#09090b', // zinc-950
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 40,
    textAlign: 'center',
    color: '#fafafa', // zinc-50
  },
  input: {
    borderWidth: 1,
    borderColor: '#27272a', // zinc-800
    backgroundColor: '#18181b', // zinc-900
    color: '#fafafa', // zinc-50
    padding: 12,
    marginBottom: 16,
    borderRadius: 8,
  },
  buttonContainer: {
    marginTop: 10,
  },
});
