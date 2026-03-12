import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const base = env.VITE_APP_BASE || '/';

    return {
        base,
        plugins: [
            react(),
            VitePWA({
                registerType: 'autoUpdate',
                includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
                manifest: {
                    name: 'AWB System - Shipment Tracker',
                    short_name: 'AWB System',
                    description: 'Real-time shipment status and tracking',
                    theme_color: '#0052cc',
                    icons: [
                        {
                            src: 'icon-512.png',
                            sizes: '512x512',
                            type: 'image/png'
                        },
                        {
                            src: 'icon-512.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'any maskable'
                        }
                    ]
                }
            })
        ],
        build: {
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return;
                        if (id.includes('/react-dom/') || id.includes('/react/')) return 'react-vendor';
                        if (id.includes('/react-router-dom/') || id.includes('/react-router/')) return 'router-vendor';
                        if (id.includes('/@tanstack/react-query/')) return 'query-vendor';
                        if (id.includes('/axios/')) return 'http-vendor';
                        if (id.includes('react-leaflet') || id.includes('leaflet')) return 'maps-vendor';
                        if (id.includes('framer-motion')) return 'motion-vendor';
                        if (id.includes('html5-qrcode')) return 'scanner-vendor';
                    }
                }
            }
        }
    };
});
