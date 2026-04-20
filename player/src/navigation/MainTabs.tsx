import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import CategoriesScreen from '../screens/CategoriesScreen';
import StreamsScreen from '../screens/StreamsScreen';
import SeriesInfoScreen from '../screens/SeriesInfoScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: '#18181b' }, // zinc-900
  headerTintColor: '#fafafa', // zinc-50
};

function TvStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Categories" component={CategoriesScreen} initialParams={{ type: 'live' }} options={{ title: 'Live TV' }} />
      <Stack.Screen name="Streams" component={StreamsScreen} />
    </Stack.Navigator>
  );
}

function VodStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Categories" component={CategoriesScreen} initialParams={{ type: 'vod' }} options={{ title: 'Movies' }} />
      <Stack.Screen name="Streams" component={StreamsScreen} />
    </Stack.Navigator>
  );
}

function SeriesStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Categories" component={CategoriesScreen} initialParams={{ type: 'series' }} options={{ title: 'Series' }} />
      <Stack.Screen name="Streams" component={StreamsScreen} />
      <Stack.Screen name="SeriesInfo" component={SeriesInfoScreen} />
    </Stack.Navigator>
  );
}

function SettingsStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="SettingsScreen" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Stack.Navigator>
  );
}

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'help-circle';

          if (route.name === 'TV') {
            iconName = focused ? 'tv' : 'tv-outline';
          } else if (route.name === 'VOD') {
            iconName = focused ? 'film' : 'film-outline';
          } else if (route.name === 'Series') {
            iconName = focused ? 'play-circle' : 'play-circle-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#6366f1', // Indigo 500
        tabBarInactiveTintColor: '#a1a1aa', // zinc-400
        tabBarStyle: {
          backgroundColor: '#18181b', // zinc-900
          borderTopColor: '#27272a', // zinc-800
        },
      })}
    >
      <Tab.Screen name="TV" component={TvStack} />
      <Tab.Screen name="VOD" component={VodStack} />
      <Tab.Screen name="Series" component={SeriesStack} />
      <Tab.Screen name="Settings" component={SettingsStack} />
    </Tab.Navigator>
  );
}
