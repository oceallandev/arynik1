import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const base = env.VITE_APP_BASE || '/';
    const buildId = env.VITE_APP_BUILD_ID || new Date().toISOString();

    return {
        base,
        define: {
            __APP_BUILD_ID__: JSON.stringify(buildId),
        },
        plugins: [
            react(),
            VitePWA({
                registerType: 'autoUpdate',
                includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
                manifest: {
                    name: 'Curieru - Last-mile Delivery',
                    short_name: 'Curieru',
                    description: 'Real-time courier operations, shipment status, and tracking',
                    theme_color: '#0f766e',
                    icons: [
                        {
                            src: 'logo-curieru.svg',
                            sizes: 'any',
                            type: 'image/svg+xml'
                        },
                        {
                            src: 'logo-curieru.svg',
                            sizes: 'any',
                            type: 'image/svg+xml',
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
