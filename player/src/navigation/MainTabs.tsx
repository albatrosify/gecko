import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import TvScreen from '../screens/TvScreen';
import VodScreen from '../screens/VodScreen';
import SeriesScreen from '../screens/SeriesScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'TV') {
            iconName = focused ? 'tv' : 'tv-outline';
          } else if (route.name === 'VOD') {
            iconName = focused ? 'film' : 'film-outline';
          } else if (route.name === 'Series') {
            iconName = focused ? 'play-circle' : 'play-circle-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          } else {
            iconName = 'help-circle';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#6366f1', // Indigo 500 (gecko default primary)
        tabBarInactiveTintColor: 'gray',
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e5e7eb',
        },
      })}
    >
      <Tab.Screen name="TV" component={TvScreen} />
      <Tab.Screen name="VOD" component={VodScreen} />
      <Tab.Screen name="Series" component={SeriesScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
