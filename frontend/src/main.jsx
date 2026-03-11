import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initTheme } from './services/theme';
import { startQueueAutoSync } from './store/queue';

import { AuthProvider } from './context/AuthContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'

const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID || '2026-03-11-live-refresh-1';
const APP_BUILD_KEY = 'arynik_app_build_id_v1';
const APP_BUILD_RELOAD_KEY = 'arynik_app_build_reload_done_v1';

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

    let alreadyReloaded = false;
    try {
        alreadyReloaded = localStorage.getItem(APP_BUILD_RELOAD_KEY) === APP_BUILD_ID;
    } catch {
        alreadyReloaded = false;
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

    if (alreadyReloaded) return;

    try {
        localStorage.setItem(APP_BUILD_RELOAD_KEY, APP_BUILD_ID);
    } catch { }

    try {
        const url = new URL(window.location.href);
        url.searchParams.set('v', APP_BUILD_ID);
        window.location.replace(url.toString());
    } catch {
        window.location.reload();
    }
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
