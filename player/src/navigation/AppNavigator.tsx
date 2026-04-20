import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import PlaylistSelectScreen from '../screens/PlaylistSelectScreen';
import MainTabs from './MainTabs';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { jwtToken, selectedPlaylist } = useAuth();

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!jwtToken ? (
        <Stack.Screen name="Login" component={LoginScreen} />
      ) : !selectedPlaylist ? (
        <Stack.Screen name="PlaylistSelect" component={PlaylistSelectScreen} />
      ) : (
        <Stack.Screen name="Main" component={MainTabs} />
      )}
    </Stack.Navigator>
  );
}
