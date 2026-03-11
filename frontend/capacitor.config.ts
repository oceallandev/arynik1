import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.arynik.lastmile',
  appName: 'Arynk Last Mile',
  webDir: 'dist',
  android: {
    useLegacyBridge: true
  },
  server: {
    androidScheme: 'https'
  },
  plugins: {
    Geolocation: {
      permissions: ['location', 'coarseLocation']
    }
  }
};

export default config;
