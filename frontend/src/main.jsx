import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initTheme } from './services/theme';
import { startQueueAutoSync } from './store/queue';

import { AuthProvider } from './context/AuthContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'

const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID || (typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev-build');
const APP_BUILD_KEY = 'arynik_app_build_id_v1';
const PRELOAD_RECOVERY_KEY = 'arynik_preload_recovery_once_v1';

const forceRefreshOnNewBuild = async () => {
    if (typeof window === 'undefined') return;

    let previous = '';
    try {
        previous = String(localStorage.getItem(APP_BUILD_KEY) || '').trim();
    } catch {
        previous = '';
    }

    if (previous === APP_BUILD_ID) {
        try {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
            }
        } catch { }
        return;
    }

    try {
        localStorage.setItem(APP_BUILD_KEY, APP_BUILD_ID);
    } catch { }

    try {
        if ('caches' in window) {
            const names = await caches.keys();
            await Promise.all(names.map((n) => caches.delete(n).catch(() => false)));
        }
    } catch { }

    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
        }
    } catch { }
};

initTheme();
startQueueAutoSync({
    getToken: () => {
        try {
            return localStorage.getItem('token');
        } catch {
            return null;
        }
    }
});

if (typeof window !== 'undefined') {
    window.addEventListener('vite:preloadError', (event) => {
        event?.preventDefault?.();
        try {
            if (sessionStorage.getItem(PRELOAD_RECOVERY_KEY) === APP_BUILD_ID) return;
            sessionStorage.setItem(PRELOAD_RECOVERY_KEY, APP_BUILD_ID);
        } catch { }
        window.location.reload();
    });

    if ('serviceWorker' in navigator) {
        // Automatically reload the page when a new service worker takes over
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloading) return;
            reloading = true;
            window.location.reload();
        });

        // Check for new app versions in the background every 10 minutes
        setInterval(() => {
            navigator.serviceWorker.getRegistrations().then(regs => {
                regs.forEach(r => r.update().catch(() => {}));
            }).catch(() => {});
        }, 10 * 60 * 1000);
    }
}

void forceRefreshOnNewBuild();

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <LanguageProvider>
            <AuthProvider>
                <App />
            </AuthProvider>
        </LanguageProvider>
    </React.StrictMode>,
)
