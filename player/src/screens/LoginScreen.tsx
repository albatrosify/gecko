import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen() {
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
    <View style={styles.container}>
      <Text style={styles.title}>Gecko Player</Text>
      <TextInput
        style={styles.input}
        placeholder="Server URL (e.g. http://192.168.1.100:3000)"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        keyboardType="url"
      />
      <TextInput
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      {isLoading ? (
        <ActivityIndicator size="large" />
      ) : (
        <Button title="Login" onPress={handleLogin} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 40,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 12,
    marginBottom: 16,
    borderRadius: 8,
  },
});
