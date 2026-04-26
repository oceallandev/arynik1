import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.arynik.lastmile',
  appName: 'Curieru',
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
