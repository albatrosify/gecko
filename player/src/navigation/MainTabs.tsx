import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import TvScreen from '../screens/TvScreen';
import VodScreen from '../screens/VodScreen';
import SeriesScreen from '../screens/SeriesScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function MainTabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen name="TV" component={TvScreen} />
      <Tab.Screen name="VOD" component={VodScreen} />
      <Tab.Screen name="Series" component={SeriesScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
