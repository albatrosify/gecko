import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import PlaylistSelectScreen from '../screens/PlaylistSelectScreen';
import MainTabs from './MainTabs';
import PlayerScreen from '../screens/PlayerScreen';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { jwtToken, selectedPlaylist } = useAuth();

  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#09090b' } }}>
      {!jwtToken ? (
        <Stack.Screen name="Login" component={LoginScreen} />
      ) : !selectedPlaylist ? (
        <Stack.Screen name="PlaylistSelect" component={PlaylistSelectScreen} />
      ) : (
        <Stack.Group>
          <Stack.Screen name="Main" component={MainTabs} />
          {/* PlayerScreen sits outside the tabs so it renders in full screen */}
          <Stack.Screen name="Player" component={PlayerScreen} options={{ presentation: 'fullScreenModal' }} />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
}
