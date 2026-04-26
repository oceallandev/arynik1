import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { BookOpenText, Info, LogOut, ShieldCheck, User, Bell, Moon, ChevronRight, Sparkles, Users, Trash2, Loader2, RefreshCw, UserCog } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { hasPermission } from '../auth/rbac';
import { normalizeRole, ROLE_ADMIN, PERM_DRIVERS_SYNC, PERM_NOTIFICATIONS_READ, PERM_POSTIS_SYNC, PERM_STATS_READ, PERM_USERS_READ } from '../auth/permissions';
import { autoDetectApiUrl, clearOfflineApiCache, getApiUrl, getApiUrlIssue, getHealth, getMapsProviderConfig, getPostisSyncStatus, getProviderSecretsStatus, setApiUrl, syncDrivers, topupMapsProviderCredit, triggerPostisSync, updateMapsProviderConfig, updateProviderSecrets } from '../services/api';
import { getPremiumState, setPremiumEnabled, subscribePremiumChanges } from '../services/premium';
import { getWarehouseOrigin, setWarehouseOrigin } from '../services/warehouse';
import { getThemeMode, setThemeMode, subscribeThemeMode } from '../services/theme';
import { clearQueue } from '../store/queue';

export default function Settings() {
    const { user, logout } = useAuth();
    const { lang, setLang, t } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);
    const navigate = useNavigate();
    const [apiUrlInput, setApiUrlInput] = useState(getApiUrl());
    const [warehouseForm, setWarehouseForm] = useState(() => {
        const o = getWarehouseOrigin();
        return {
            label: String(o?.label || ''),
            lat: String(o?.lat ?? ''),
            lon: String(o?.lon ?? ''),
        };
    });
    const [warehouseMsg, setWarehouseMsg] = useState('');
    const [cacheBusy, setCacheBusy] = useState(false);
    const [cacheMsg, setCacheMsg] = useState('');
    const [postisBusy, setPostisBusy] = useState(false);
    const [postisMsg, setPostisMsg] = useState('');
    const [postisStatus, setPostisStatus] = useState(null);
    const [driversBusy, setDriversBusy] = useState(false);
    const [driversMsg, setDriversMsg] = useState('');
    const [healthBusy, setHealthBusy] = useState(false);
    const [autoDetectBusy, setAutoDetectBusy] = useState(false);
    const [healthMsg, setHealthMsg] = useState('');
    const [healthData, setHealthData] = useState(null);
    const [premiumState, setPremiumState] = useState(() => getPremiumState());
    const [premiumMsg, setPremiumMsg] = useState('');
    const [themeMode, setThemeModeState] = useState(() => getThemeMode());
    const [themeMsg, setThemeMsg] = useState('');
    const [providerSecretsBusy, setProviderSecretsBusy] = useState(false);
    const [providerSecretsMsg, setProviderSecretsMsg] = useState('');
    const [providerSecretsStatus, setProviderSecretsStatus] = useState({
        openai_api_key: { configured: false, masked: null },
        elevenlabs_api_key: { configured: false, masked: null },
    });
    const [openAiKeyInput, setOpenAiKeyInput] = useState('');
    const [elevenLabsKeyInput, setElevenLabsKeyInput] = useState('');
    const [mapsProviderBusy, setMapsProviderBusy] = useState(false);
    const [mapsProviderMsg, setMapsProviderMsg] = useState('');
    const [mapsProviderStatus, setMapsProviderStatus] = useState({
        maps_mode: 'platform',
        own_maps_api_key: { configured: false, masked: null },
        platform_google_maps_api_key: { configured: false, masked: null },
        pricing_per_1000: 0,
        pricing_per_request: 0,
        platform_credit_balance: 0,
        platform_usage_requests: 0,
        platform_usage_cost: 0,
        platform_remaining_estimated_requests: null,
        recent_usage: [],
    });
    const [mapsModeInput, setMapsModeInput] = useState('platform');
    const [mapsOwnKeyInput, setMapsOwnKeyInput] = useState('');
    const [mapsPlatformKeyInput, setMapsPlatformKeyInput] = useState('');
    const [mapsTopupAmount, setMapsTopupAmount] = useState('');

    const canReadUsers = hasPermission(user, PERM_USERS_READ);
    const canReadNotifications = hasPermission(user, PERM_NOTIFICATIONS_READ);
    const canSyncPostis = hasPermission(user, PERM_POSTIS_SYNC);
    const canSyncDrivers = hasPermission(user, PERM_DRIVERS_SYNC);
    const canReadAnalytics = hasPermission(user, PERM_STATS_READ);
    const isAdmin = normalizeRole(user?.role) === ROLE_ADMIN;
    const profileName = user?.name || user?.username || l('Driver', 'Sofer');
    const profileUsername = String(user?.username || '').trim();

    const handleLogout = () => {
        logout();
        navigate('/login', { replace: true });
    };

    const applyApiUrl = () => {
        const saved = setApiUrl(apiUrlInput);
        if (!saved?.ok) {
            setHealthMsg(saved?.issue || l('Invalid Backend API URL.', 'URL API Backend invalid.'));
            setTimeout(() => setHealthMsg(''), 9000);
            return;
        }
        setApiUrlInput(saved?.apiUrl || getApiUrl());
        window.location.reload();
    };

    const testConnection = async () => {
        setHealthBusy(true);
        setHealthMsg('');
        setHealthData(null);

        try {
            const issue = getApiUrlIssue(getApiUrl());
            if (issue) {
                setHealthMsg(issue);
                return;
            }
            const data = await getHealth();
            setHealthData(data || null);
            setHealthMsg(data?.ok ? l('Backend reachable.', 'Backend disponibil.') : l('Backend responded.', 'Backend a raspuns.'));
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Backend unreachable.', 'Backend indisponibil.');
            setHealthMsg(String(detail));
        } finally {
            setHealthBusy(false);
            setTimeout(() => setHealthMsg(''), 9000);
        }
    };

    const autoDetectConnection = async () => {
        setAutoDetectBusy(true);
        setHealthData(null);
        setHealthMsg('');
        try {
            const detected = await autoDetectApiUrl({ persist: true });
            if (!detected?.ok || !detected?.apiUrl) {
                setHealthMsg(detected?.issue || l('No backend detected.', 'Nu am detectat backend-ul.'));
                return;
            }
            setApiUrlInput(detected.apiUrl);
            const data = await getHealth();
            setHealthData(data || null);
            setHealthMsg(l(`Connected to ${detected.apiUrl}`, `Conectat la ${detected.apiUrl}`));
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Auto-detect failed.', 'Auto-detect a esuat.');
            setHealthMsg(String(detail));
        } finally {
            setAutoDetectBusy(false);
            setTimeout(() => setHealthMsg(''), 9000);
        }
    };

    const applyWarehouse = () => {
        const ok = setWarehouseOrigin({
            label: warehouseForm.label,
            lat: warehouseForm.lat,
            lon: warehouseForm.lon,
        });
        setWarehouseMsg(ok ? l('Warehouse origin saved.', 'Originea depozitului a fost salvata.') : l('Invalid warehouse coordinates.', 'Coordonate depozit invalide.'));
        setTimeout(() => setWarehouseMsg(''), 2500);
    };

    const clearCache = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            l(
                'Clear cached data on this device?\n\nThis removes:\n- Offline queue (pending updates)\n- Local route allocations\n- Geocode cache\n- Service worker caches\n\nYou will stay signed in.',
                'Stergi datele cache de pe acest dispozitiv?\n\nAcest lucru sterge:\n- Coada offline (actualizari in asteptare)\n- Alocari locale pe rute\n- Cache geocodare\n- Cache service worker\n\nRamaneti autentificat.'
            )
        );
        if (!ok) return;

        setCacheBusy(true);
        setCacheMsg('');

        let removedQueue = 0;
        let removedCaches = 0;
        let removedApiCache = 0;

        try {
            removedQueue = await clearQueue();
        } catch { }
        try {
            removedApiCache = await clearOfflineApiCache();
        } catch { }

        const localKeys = [
            'arynik_geocode_cache_v1',
            'arynik_geocode_cache_v2',
            'arynik_routes_v1',
            'arynik_demo_logs_v1',
            'arynik_demo_shipments_v1',
            'arynik_last_vehicle_plate_v1',
            'arynik_warehouse_origin_v1',
        ];
        localKeys.forEach((key) => {
            try { localStorage.removeItem(key); } catch { }
        });

        if (typeof window !== 'undefined' && 'caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
                removedCaches = keys.length;
            } catch { }
        }

        // Best-effort SW unregister, so next reload re-registers cleanly.
        if (navigator?.serviceWorker?.getRegistrations) {
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
            } catch { }
        }

        setCacheMsg(l(
            `Cleared ${removedCaches} service-worker cache(s), ${removedApiCache} offline API cache item(s), and ${removedQueue} queued update(s). Reloading...`,
            `S-au sters ${removedCaches} cache-uri service worker, ${removedApiCache} elemente cache API offline si ${removedQueue} actualizari din coada. Se reincarca...`
        ));

        setTimeout(() => {
            window.location.reload();
        }, 600);
    };

    const refreshPostisStatus = async () => {
        const token = user?.token;
        if (!token) return null;
        try {
            const st = await getPostisSyncStatus(token);
            setPostisStatus(st);
            return st;
        } catch {
            return null;
        }
    };

    const syncWithPostis = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            l(
                'Sync shipments with Postis now?\n\nThis will run a FULL backfill (cost/content/address/raw payload) into the server database.\nIt may take several minutes.',
                'Sincronizezi acum coletele cu Postis?\n\nSe va rula un backfill COMPLET (cost/continut/adresa/date brute) in baza de date de pe server.\nPoate dura cateva minute.'
            )
        );
        if (!ok) return;

        const issue = getApiUrlIssue(getApiUrl());
        if (issue) {
            setPostisMsg(issue);
            setTimeout(() => setPostisMsg(''), 9000);
            return;
        }

        const token = user?.token;
        if (!token) {
            setPostisMsg(l('Not signed in.', 'Nu esti autentificat.'));
            setTimeout(() => setPostisMsg(''), 4000);
            return;
        }

        setPostisBusy(true);
        setPostisMsg('');

        try {
            const started = await triggerPostisSync(token, { mode: 'full' });
            setPostisStatus(started);

            const didStart = Boolean(started?.started);
            setPostisMsg(didStart ? l('Postis sync started.', 'Sincronizarea Postis a pornit.') : l('Postis sync is already running.', 'Sincronizarea Postis ruleaza deja.'));

            const deadline = Date.now() + 8 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const st = await refreshPostisStatus();
                if (!st?.running) break;
            }

            const st = await refreshPostisStatus();
            if (st?.running) {
                setPostisMsg(l('Postis sync is still running in the background.', 'Sincronizarea Postis ruleaza in continuare in fundal.'));
            } else if (st?.last_error) {
                setPostisMsg(l(`Postis sync failed: ${st.last_error}`, `Sincronizarea Postis a esuat: ${st.last_error}`));
            } else if (st?.last_stats) {
                const s = st.last_stats;
                setPostisMsg(l(
                    `Postis sync done. List: ${s.upserted_list} • Details: ${s.upserted_details}.`,
                    `Sincronizare Postis finalizata. Lista: ${s.upserted_list} • Detalii: ${s.upserted_details}.`
                ));
            } else {
                setPostisMsg(l('Postis sync done.', 'Sincronizare Postis finalizata.'));
            }
        } catch (e) {
            if (Number(e?.response?.status) === 405) {
                const api = getApiUrl();
                setPostisMsg(l(
                    `Sync failed (HTTP 405). Your API URL is not a backend server (likely GitHub Pages). Set Backend API URL above to your FastAPI backend (/docs). Current: ${api}`,
                    `Sincronizarea a esuat (HTTP 405). URL-ul API nu este un backend (probabil GitHub Pages). Seteaza URL-ul API Backend de mai sus catre FastAPI (/docs). Curent: ${api}`
                ));
                return;
            }
            const detail = e?.response?.data?.detail || e?.message || l('Failed to sync with Postis.', 'Nu am putut sincroniza cu Postis.');
            setPostisMsg(String(detail));
        } finally {
            setPostisBusy(false);
            setTimeout(() => setPostisMsg(''), 9000);
        }
    };

    const refreshDrivers = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            l(
                'Refresh users/drivers now?\n\nUsers are managed directly in the server database.',
                'Reimprospatezi acum utilizatorii/soferii?\n\nUtilizatorii sunt administrati direct in baza de date de pe server.'
            )
        );
        if (!ok) return;

        const token = user?.token;
        if (!token) {
            setDriversMsg(l('Not signed in.', 'Nu esti autentificat.'));
            setTimeout(() => setDriversMsg(''), 4000);
            return;
        }

        setDriversBusy(true);
        setDriversMsg('');

        try {
            const result = await syncDrivers(token);
            const source = String(result?.source || '').toLowerCase();
            const usersTotal = Number(result?.users_total || 0);
            const usersActive = Number(result?.users_active || 0);
            const driversTotal = Number(result?.drivers_total || 0);
            const driversActive = Number(result?.drivers_active || 0);
            if (source === 'database') {
                setDriversMsg(l(
                    `Drivers are managed in database. Drivers: ${driversTotal} • Active drivers: ${driversActive} • Users: ${usersTotal} • Active users: ${usersActive}.`,
                    `Soferii sunt administrati in baza de date. Soferi: ${driversTotal} • Soferi activi: ${driversActive} • Utilizatori: ${usersTotal} • Utilizatori activi: ${usersActive}.`
                ));
            } else {
                setDriversMsg(l(
                    `Drivers synced. Drivers: ${driversTotal} • Active drivers: ${driversActive}.`,
                    `Soferi sincronizati. Soferi: ${driversTotal} • Soferi activi: ${driversActive}.`
                ));
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Failed to sync drivers.', 'Nu am putut sincroniza soferii.');
            setDriversMsg(String(detail));
        } finally {
            setDriversBusy(false);
            setTimeout(() => setDriversMsg(''), 9000);
        }
    };

    const loadProviderSecrets = async () => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) return;
        setProviderSecretsBusy(true);
        setProviderSecretsMsg('');
        try {
            const status = await getProviderSecretsStatus(token);
            setProviderSecretsStatus({
                openai_api_key: status?.openai_api_key || { configured: false, masked: null },
                elevenlabs_api_key: status?.elevenlabs_api_key || { configured: false, masked: null },
            });
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot load provider secrets status.', 'Nu pot incarca statusul cheilor provider.');
            setProviderSecretsMsg(String(detail));
        } finally {
            setProviderSecretsBusy(false);
        }
    };

    const saveProviderSecrets = async () => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) {
            setProviderSecretsMsg(l('Not signed in.', 'Nu esti autentificat.'));
            return;
        }

        const payload = { persist_to_env: true };
        const openAi = String(openAiKeyInput || '').trim();
        const eleven = String(elevenLabsKeyInput || '').trim();
        if (openAi) payload.openai_api_key = openAi;
        if (eleven) payload.elevenlabs_api_key = eleven;

        if (!Object.prototype.hasOwnProperty.call(payload, 'openai_api_key') && !Object.prototype.hasOwnProperty.call(payload, 'elevenlabs_api_key')) {
            setProviderSecretsMsg(l('Enter at least one API key to save.', 'Introdu cel putin o cheie API pentru salvare.'));
            setTimeout(() => setProviderSecretsMsg(''), 5000);
            return;
        }

        setProviderSecretsBusy(true);
        setProviderSecretsMsg('');
        try {
            const res = await updateProviderSecrets(token, payload);
            setProviderSecretsStatus({
                openai_api_key: res?.openai_api_key || { configured: false, masked: null },
                elevenlabs_api_key: res?.elevenlabs_api_key || { configured: false, masked: null },
            });
            setOpenAiKeyInput('');
            setElevenLabsKeyInput('');
            setProviderSecretsMsg(l('Provider keys saved securely on server.', 'Cheile provider au fost salvate securizat pe server.'));
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot save provider keys.', 'Nu pot salva cheile provider.');
            setProviderSecretsMsg(String(detail));
        } finally {
            setProviderSecretsBusy(false);
            setTimeout(() => setProviderSecretsMsg(''), 7000);
        }
    };

    const clearProviderKey = async (provider) => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) return;
        setProviderSecretsBusy(true);
        setProviderSecretsMsg('');
        try {
            const payload = { persist_to_env: true };
            if (provider === 'openai') payload.openai_api_key = '';
            if (provider === 'elevenlabs') payload.elevenlabs_api_key = '';
            const res = await updateProviderSecrets(token, payload);
            setProviderSecretsStatus({
                openai_api_key: res?.openai_api_key || { configured: false, masked: null },
                elevenlabs_api_key: res?.elevenlabs_api_key || { configured: false, masked: null },
            });
            setProviderSecretsMsg(l('Provider key removed.', 'Cheia provider a fost stearsa.'));
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot clear provider key.', 'Nu pot sterge cheia provider.');
            setProviderSecretsMsg(String(detail));
        } finally {
            setProviderSecretsBusy(false);
            setTimeout(() => setProviderSecretsMsg(''), 7000);
        }
    };

    const loadMapsProviderConfig = async () => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) return;
        setMapsProviderBusy(true);
        setMapsProviderMsg('');
        try {
            const status = await getMapsProviderConfig(token);
            const next = status || {};
            setMapsProviderStatus({
                maps_mode: next?.maps_mode || 'platform',
                own_maps_api_key: next?.own_maps_api_key || { configured: false, masked: null },
                platform_google_maps_api_key: next?.platform_google_maps_api_key || { configured: false, masked: null },
                pricing_per_1000: Number(next?.pricing_per_1000 || 0) || 0,
                pricing_per_request: Number(next?.pricing_per_request || 0) || 0,
                platform_credit_balance: Number(next?.platform_credit_balance || 0) || 0,
                platform_usage_requests: Number(next?.platform_usage_requests || 0) || 0,
                platform_usage_cost: Number(next?.platform_usage_cost || 0) || 0,
                platform_remaining_estimated_requests: Number.isFinite(Number(next?.platform_remaining_estimated_requests))
                    ? Number(next.platform_remaining_estimated_requests)
                    : null,
                recent_usage: Array.isArray(next?.recent_usage) ? next.recent_usage.slice(0, 20) : [],
            });
            setMapsModeInput(String(next?.maps_mode || 'platform').trim().toLowerCase() === 'own' ? 'own' : 'platform');
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot load Maps provider config.', 'Nu pot incarca configuratia providerului Maps.');
            setMapsProviderMsg(String(detail));
        } finally {
            setMapsProviderBusy(false);
        }
    };

    const saveMapsProviderConfig = async () => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) {
            setMapsProviderMsg(l('Not signed in.', 'Nu esti autentificat.'));
            return;
        }

        const payload = {
            maps_mode: mapsModeInput === 'own' ? 'own' : 'platform',
            persist_to_env: true,
        };
        const own = String(mapsOwnKeyInput || '').trim();
        const platform = String(mapsPlatformKeyInput || '').trim();
        if (own) payload.own_maps_api_key = own;
        if (platform) payload.platform_google_maps_api_key = platform;

        setMapsProviderBusy(true);
        setMapsProviderMsg('');
        try {
            await updateMapsProviderConfig(token, payload);
            setMapsOwnKeyInput('');
            setMapsPlatformKeyInput('');
            setMapsProviderMsg(l('Maps provider config saved.', 'Configuratia Maps a fost salvata.'));
            await loadMapsProviderConfig();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot save Maps provider config.', 'Nu pot salva configuratia Maps.');
            setMapsProviderMsg(String(detail));
        } finally {
            setMapsProviderBusy(false);
            setTimeout(() => setMapsProviderMsg(''), 7000);
        }
    };

    const clearMapsKey = async (target) => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) return;

        setMapsProviderBusy(true);
        setMapsProviderMsg('');
        try {
            const payload = { persist_to_env: true };
            if (target === 'own') payload.own_maps_api_key = '';
            if (target === 'platform') payload.platform_google_maps_api_key = '';
            await updateMapsProviderConfig(token, payload);
            setMapsProviderMsg(l('Maps key removed.', 'Cheia Maps a fost stearsa.'));
            await loadMapsProviderConfig();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot clear Maps key.', 'Nu pot sterge cheia Maps.');
            setMapsProviderMsg(String(detail));
        } finally {
            setMapsProviderBusy(false);
            setTimeout(() => setMapsProviderMsg(''), 7000);
        }
    };

    const topupMapsCredit = async () => {
        if (!isAdmin) return;
        const token = user?.token;
        if (!token) return;
        const amount = Number(mapsTopupAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            setMapsProviderMsg(l('Enter a valid top-up amount.', 'Introdu o suma valida de incarcare.'));
            setTimeout(() => setMapsProviderMsg(''), 5000);
            return;
        }

        setMapsProviderBusy(true);
        setMapsProviderMsg('');
        try {
            await topupMapsProviderCredit(token, { amount, note: 'settings_topup' });
            setMapsTopupAmount('');
            setMapsProviderMsg(l('Credit added successfully.', 'Credit adaugat cu succes.'));
            await loadMapsProviderConfig();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Cannot top up credit.', 'Nu pot incarca creditul.');
            setMapsProviderMsg(String(detail));
        } finally {
            setMapsProviderBusy(false);
            setTimeout(() => setMapsProviderMsg(''), 7000);
        }
    };

    const showAppInfo = () => {
        const api = getApiUrl() || '-';
        // eslint-disable-next-line no-alert
        window.alert(
            l(
                `Curieru\nVersion: 1.0.0\nAPI: ${api}\nRole: ${user?.role || '-'}`,
                `Curieru\nVersiune: 1.0.0\nAPI: ${api}\nRol: ${user?.role || '-'}`
            )
        );
    };

    const togglePremium = () => {
        const next = !Boolean(premiumState?.enabled);
        const updated = setPremiumEnabled(next);
        setPremiumState(updated);
        if (next) {
            setPremiumMsg(l('Premium mode enabled. Advanced analytics UI is now unlocked.', 'Modul Premium este activ. UI-ul de analitice avansate este deblocat.'));
        } else {
            setPremiumMsg(l('Premium mode disabled.', 'Modul Premium este dezactivat.'));
        }
        setTimeout(() => setPremiumMsg(''), 5000);
    };

    useEffect(() => subscribePremiumChanges((state) => setPremiumState(state)), []);
    useEffect(() => subscribeThemeMode((mode) => setThemeModeState(mode)), []);

    const themeModeLabel = (() => {
        if (themeMode === 'light') return l('Light', 'Luminos');
        if (themeMode === 'dark') return l('Dark', 'Intunecat');
        return l('Auto', 'Auto');
    })();

    const cycleThemeMode = () => {
        const next = themeMode === 'auto' ? 'dark' : themeMode === 'dark' ? 'light' : 'auto';
        const mode = setThemeMode(next);
        setThemeModeState(mode);
        setThemeMsg(l(`Theme set to ${mode}.`, `Tema setata pe ${mode}.`));
        setTimeout(() => setThemeMsg(''), 3500);
    };

    useEffect(() => {
        let cancelled = false;
        if (!canSyncPostis) return undefined;

        (async () => {
            const st = await refreshPostisStatus();
            if (cancelled || !st?.running) return;

            // If a sync is in progress, keep polling so the UI updates.
            const deadline = Date.now() + 60 * 1000;
            while (!cancelled && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const next = await refreshPostisStatus();
                if (!next?.running) break;
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canSyncPostis]);

    useEffect(() => {
        if (!isAdmin) return;
        void loadProviderSecrets();
        void loadMapsProviderConfig();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAdmin, user?.token]);

    const settingsSections = [
        {
            title: lang === 'ro' ? 'Preferinte' : 'Preferences',
            items: [
                ...(canReadNotifications ? [{
                    icon: Bell,
                    label: lang === 'ro' ? 'Notificari' : 'Notifications',
                    value: null,
                    color: 'violet',
                    onClick: () => navigate('/notifications'),
                }] : []),
                {
                    icon: Moon,
                    label: lang === 'ro' ? 'Tema Aplicatie' : 'App Theme',
                    value: themeModeLabel,
                    color: 'amber',
                    onClick: cycleThemeMode,
                },
            ]
        },
        {
            title: lang === 'ro' ? 'Cont' : 'Account',
            items: [
                {
                    icon: ShieldCheck,
                    label: lang === 'ro' ? 'Securitate' : 'Security',
                    value: l('Managed by account + role permissions', 'Gestionat prin cont + permisiuni rol'),
                    color: 'violet',
                    onClick: () => setHealthMsg(l('Security is controlled by role permissions.', 'Securitatea este controlata de permisiunile rolului.')),
                },
                ...(canReadUsers ? [{ icon: UserCog, label: lang === 'ro' ? 'Administrare Utilizatori' : 'Manage Users', value: null, color: 'emerald', onClick: () => navigate('/users') }] : []),
                ...(canSyncDrivers ? [{
                    icon: Users,
                    label: l('Refresh Drivers', 'Reimprospateaza soferii'),
                    value: driversBusy ? l('Working...', 'Se proceseaza...') : null,
                    color: 'violet',
                    onClick: () => { if (!driversBusy) refreshDrivers(); },
                    disabled: driversBusy,
                    loading: driversBusy,
                }] : []),
                ...(canSyncPostis ? [{
                    icon: RefreshCw,
                    label: l('Sync with Postis (Full)', 'Sincronizare cu Postis (complet)'),
                    value: (postisBusy || postisStatus?.running) ? l('Running...', 'Ruleaza...') : null,
                    color: 'emerald',
                    onClick: () => { if (!(postisBusy || postisStatus?.running)) syncWithPostis(); },
                    disabled: (postisBusy || postisStatus?.running),
                    loading: (postisBusy || postisStatus?.running),
                }] : []),
                ...(isAdmin ? [{ icon: Trash2, label: lang === 'ro' ? 'Sterge Cache' : 'Clear Cache', value: cacheBusy ? (lang === 'ro' ? 'Se lucreaza…' : 'Working…') : null, color: 'slate', onClick: () => { if (!cacheBusy) clearCache(); }, disabled: cacheBusy, loading: cacheBusy }] : []),
                { icon: Info, label: lang === 'ro' ? 'Info Aplicatie' : 'App Info', value: 'v1.0.0', color: 'slate', onClick: showAppInfo }
            ]
        }
    ];

    const getIconBg = (color) => {
        const colors = {
            violet: 'bg-violet-500/20',
            emerald: 'bg-emerald-500/20',
            amber: 'bg-amber-500/20',
            slate: 'bg-slate-500/20'
        };
        return colors[color] || colors.slate;
    };

    const getIconColor = (color) => {
        const colors = {
            violet: 'text-violet-400',
            emerald: 'text-emerald-400',
            amber: 'text-amber-400',
            slate: 'text-slate-400'
        };
        return colors[color] || colors.slate;
    };

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -20 }}
            variants={containerVariants}
            className="min-h-screen flex flex-col relative overflow-x-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Compact Header */}
            <div className="px-4 pt-4 relative z-10">
                <div className="glass-strong rounded-3xl border-iridescent p-5">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 text-white flex items-center justify-center shadow-glow-sm">
                            <User size={24} strokeWidth={2} />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h1 className="text-lg font-black text-white uppercase tracking-tight truncate">
                                {t('settings.title', 'Settings')}
                            </h1>
                            <p className="text-base font-black text-white truncate mt-0.5">
                                {profileName}
                            </p>
                            {profileUsername ? (
                                <p className="text-[12px] text-violet-200 font-semibold truncate">
                                    @{profileUsername}
                                </p>
                            ) : null}
                            <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider truncate mt-1">
                                {user?.role || l('Carrier', 'Curier')} • ID: {user?.driver_id || 'N/A'}
                            </p>
                            <p className="text-[10px] text-cyan-200 font-black uppercase tracking-widest truncate mt-1">
                                Companie: AryNik
                            </p>
                        </div>
                    </div>
                    <div className="mt-4">
                        <button
                            type="button"
                            onClick={() => navigate('/manual')}
                            className="w-full min-h-[48px] px-4 py-3 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 text-indigo-100 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-indigo-500/30 active:scale-[0.99] transition-all"
                        >
                            <BookOpenText size={16} />
                            {l('Open Usage Manual', 'Deschide manualul de utilizare')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Settings Content */}
            <div className="flex-1 p-4 space-y-6 pb-32 relative z-10">
                <motion.div variants={itemVariants} className="space-y-3">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                        {t('settings.language', 'Language')}
                    </h3>
                    <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                        <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">
                            {t('settings.language_hint', 'Change app language for all drivers')}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setLang('en')}
                                className={`px-4 py-3.5 rounded-xl border text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${lang === 'en' ? 'bg-violet-500/20 border-violet-400/40 text-violet-100' : 'bg-slate-900/40 border-white/10 text-slate-300'}`}
                            >
                                {t('settings.lang_en', 'English')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setLang('ro')}
                                className={`px-4 py-3.5 rounded-xl border text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${lang === 'ro' ? 'bg-violet-500/20 border-violet-400/40 text-violet-100' : 'bg-slate-900/40 border-white/10 text-slate-300'}`}
                            >
                                {t('settings.lang_ro', 'Romanian')}
                            </button>
                        </div>
                    </div>
                </motion.div>

                {/* Connection */}
                {isAdmin ? (
                    <motion.div variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {l('Connection', 'Conexiune')}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                {l('API Base URL', 'URL baza API')}
                            </label>
                            <input
                                value={apiUrlInput}
                                onChange={(e) => setApiUrlInput(e.target.value)}
                                placeholder={l('https://YOUR-BACKEND', 'https://BACKEND-UL-TAU')}
                                className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 transition-all duration-300 text-sm font-medium"
                            />
                            <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                                {l('Tip: on HTTPS domains, backend must also be HTTPS. You can also set via URL:', 'Sfat: pe domenii HTTPS, backend-ul trebuie sa fie tot HTTPS. Poti seta si prin URL:')} <span className="font-mono text-slate-400">?api=https://YOUR-BACKEND</span>
                            </p>
                            <button
                                onClick={applyApiUrl}
                                className="w-full min-h-[52px] btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider"
                            >
                                {l('Apply API URL', 'Aplica URL API')}
                            </button>
                            <button
                                type="button"
                                onClick={autoDetectConnection}
                                disabled={autoDetectBusy}
                                className="w-full min-h-[52px] btn-premium py-3 bg-emerald-600/80 hover:bg-emerald-500 text-white rounded-xl font-bold border border-emerald-400/30 transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {autoDetectBusy ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
                                {l('Auto Detect Backend', 'Detecteaza backend automat')}
                            </button>
                            <button
                                type="button"
                                onClick={testConnection}
                                disabled={healthBusy || autoDetectBusy}
                                className="w-full min-h-[52px] btn-premium py-3 bg-slate-900/50 hover:bg-slate-900/70 text-white rounded-xl font-bold border border-white/10 transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {healthBusy ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
                                {l('Test Connection', 'Testeaza conexiunea')}
                            </button>
                            {healthMsg ? (
                                <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-200 text-xs font-bold">
                                    {healthMsg}
                                </div>
                            ) : null}
                            {healthData ? (
                                <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-300 text-[10px] font-bold space-y-1">
                                    <div>{healthData?.ok ? 'OK' : l('Response', 'Raspuns')} • {String(healthData?.time || '')}</div>
                                    <div>{l('Postis configured', 'Postis configurat')}: {healthData?.postis_configured ? l('YES', 'DA') : l('NO', 'NU')}</div>
                                </div>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}

                {/* Warehouse Origin */}
                {isAdmin ? (
                    <motion.div variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {l('Warehouse', 'Depozit')}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                {l('Routing Origin (Used For KM/Routes)', 'Origine rutare (folosita pentru KM/rute)')}
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                                <input
                                    value={warehouseForm.label}
                                    onChange={(e) => setWarehouseForm((prev) => ({ ...prev, label: e.target.value }))}
                                    placeholder={l('Warehouse (Bacau)', 'Depozit (Bacau)')}
                                    className="col-span-3 px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                                />
                                <input
                                    value={warehouseForm.lat}
                                    onChange={(e) => setWarehouseForm((prev) => ({ ...prev, lat: e.target.value }))}
                                    placeholder={l('Latitude', 'Latitudine')}
                                    className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono"
                                />
                                <input
                                    value={warehouseForm.lon}
                                    onChange={(e) => setWarehouseForm((prev) => ({ ...prev, lon: e.target.value }))}
                                    placeholder={l('Longitude', 'Longitudine')}
                                    className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono"
                                />
                                <button
                                    onClick={applyWarehouse}
                                    className="btn-premium min-h-[48px] py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider"
                                >
                                    {l('Save Warehouse', 'Salveaza depozitul')}
                                </button>
                            </div>
                            {warehouseMsg && (
                                <div className="glass-light p-3 rounded-xl border border-emerald-500/20 text-emerald-200 text-xs font-bold">
                                    {warehouseMsg}
                                </div>
                            )}
                            <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                                {l('Driver GPS is still shown on the map, but routing always starts from this warehouse origin.', 'GPS-ul soferului ramane afisat pe harta, dar rutarea incepe mereu din aceasta origine de depozit.')}
                            </p>
                        </div>
                    </motion.div>
                ) : null}

                {isAdmin ? (
                    <motion.div variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {l('AI Providers', 'Provideri AI')}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                                {l('Keys are sent to backend and persisted server-side in backend/.env. They are never returned in full.', 'Cheile sunt trimise catre backend si salvate server-side in backend/.env. Nu sunt returnate niciodata integral.')}
                            </p>

                            <div className="grid grid-cols-1 gap-2">
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                    OPENAI_API_KEY
                                    <input
                                        type="password"
                                        value={openAiKeyInput}
                                        onChange={(e) => setOpenAiKeyInput(e.target.value)}
                                        placeholder={l('Paste OpenAI key to set/update', 'Introdu cheia OpenAI pentru setare/actualizare')}
                                        className="mt-1 w-full px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all duration-300 text-sm font-medium"
                                    />
                                </label>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${providerSecretsStatus?.openai_api_key?.configured
                                        ? 'bg-emerald-500/20 text-emerald-200 border-emerald-300/30'
                                        : 'bg-slate-900/40 text-slate-300 border-white/10'
                                        }`}>
                                        {providerSecretsStatus?.openai_api_key?.configured
                                            ? l(`Configured (${providerSecretsStatus?.openai_api_key?.masked || '***'})`, `Configurata (${providerSecretsStatus?.openai_api_key?.masked || '***'})`)
                                            : l('Not configured', 'Neconfigurata')}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => clearProviderKey('openai')}
                                        disabled={providerSecretsBusy || !providerSecretsStatus?.openai_api_key?.configured}
                                        className="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border border-rose-400/30 bg-rose-500/15 text-rose-100 disabled:opacity-60"
                                    >
                                        {l('Clear', 'Sterge')}
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-2">
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                    ELEVENLABS_API_KEY
                                    <input
                                        type="password"
                                        value={elevenLabsKeyInput}
                                        onChange={(e) => setElevenLabsKeyInput(e.target.value)}
                                        placeholder={l('Paste ElevenLabs key to set/update', 'Introdu cheia ElevenLabs pentru setare/actualizare')}
                                        className="mt-1 w-full px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all duration-300 text-sm font-medium"
                                    />
                                </label>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${providerSecretsStatus?.elevenlabs_api_key?.configured
                                        ? 'bg-emerald-500/20 text-emerald-200 border-emerald-300/30'
                                        : 'bg-slate-900/40 text-slate-300 border-white/10'
                                        }`}>
                                        {providerSecretsStatus?.elevenlabs_api_key?.configured
                                            ? l(`Configured (${providerSecretsStatus?.elevenlabs_api_key?.masked || '***'})`, `Configurata (${providerSecretsStatus?.elevenlabs_api_key?.masked || '***'})`)
                                            : l('Not configured', 'Neconfigurata')}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => clearProviderKey('elevenlabs')}
                                        disabled={providerSecretsBusy || !providerSecretsStatus?.elevenlabs_api_key?.configured}
                                        className="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border border-rose-400/30 bg-rose-500/15 text-rose-100 disabled:opacity-60"
                                    >
                                        {l('Clear', 'Sterge')}
                                    </button>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={saveProviderSecrets}
                                disabled={providerSecretsBusy}
                                className="w-full min-h-[52px] btn-premium py-3 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {providerSecretsBusy ? <Loader2 className="animate-spin" size={18} /> : <ShieldCheck size={18} />}
                                {l('Save AI Keys', 'Salveaza cheile AI')}
                            </button>

                            {providerSecretsMsg ? (
                                <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-200 text-xs font-bold">
                                    {providerSecretsMsg}
                                </div>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}

                {isAdmin ? (
                    <motion.div variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {l('Maps Provider & Billing', 'Provider Maps si Facturare')}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                                {l('Set own Google key per warehouse admin, or use platform key with usage tracking and credit balance.', 'Seteaza cheia Google proprie per admin de depozit, sau foloseste cheia platformei cu tracking de consum si sold credit.')}
                            </p>

                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                {l('Maps mode', 'Mod Maps')}
                                <select
                                    value={mapsModeInput}
                                    onChange={(e) => setMapsModeInput(e.target.value === 'own' ? 'own' : 'platform')}
                                    className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                                >
                                    <option value="platform">{l('Platform key (billable)', 'Cheia platformei (facturabil)')}</option>
                                    <option value="own">{l('Own key (your Google account)', 'Cheie proprie (contul tau Google)')}</option>
                                </select>
                            </label>

                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                OWN_GOOGLE_MAPS_API_KEY
                                <input
                                    type="password"
                                    value={mapsOwnKeyInput}
                                    onChange={(e) => setMapsOwnKeyInput(e.target.value)}
                                    placeholder={l('Paste own Google Maps API key', 'Introdu cheia Google Maps proprie')}
                                    className="mt-1 w-full px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all duration-300 text-sm font-medium"
                                />
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${mapsProviderStatus?.own_maps_api_key?.configured
                                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-300/30'
                                    : 'bg-slate-900/40 text-slate-300 border-white/10'
                                    }`}>
                                    {mapsProviderStatus?.own_maps_api_key?.configured
                                        ? l(`Configured (${mapsProviderStatus?.own_maps_api_key?.masked || '***'})`, `Configurata (${mapsProviderStatus?.own_maps_api_key?.masked || '***'})`)
                                        : l('Not configured', 'Neconfigurata')}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => clearMapsKey('own')}
                                    disabled={mapsProviderBusy || !mapsProviderStatus?.own_maps_api_key?.configured}
                                    className="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border border-rose-400/30 bg-rose-500/15 text-rose-100 disabled:opacity-60"
                                >
                                    {l('Clear', 'Sterge')}
                                </button>
                            </div>

                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                GOOGLE_MAPS_API_KEY (Platform)
                                <input
                                    type="password"
                                    value={mapsPlatformKeyInput}
                                    onChange={(e) => setMapsPlatformKeyInput(e.target.value)}
                                    placeholder={l('Paste platform Google Maps API key (optional)', 'Introdu cheia Google Maps a platformei (optional)')}
                                    className="mt-1 w-full px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all duration-300 text-sm font-medium"
                                />
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${mapsProviderStatus?.platform_google_maps_api_key?.configured
                                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-300/30'
                                    : 'bg-slate-900/40 text-slate-300 border-white/10'
                                    }`}>
                                    {mapsProviderStatus?.platform_google_maps_api_key?.configured
                                        ? l(`Configured (${mapsProviderStatus?.platform_google_maps_api_key?.masked || '***'})`, `Configurata (${mapsProviderStatus?.platform_google_maps_api_key?.masked || '***'})`)
                                        : l('Not configured', 'Neconfigurata')}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => clearMapsKey('platform')}
                                    disabled={mapsProviderBusy || !mapsProviderStatus?.platform_google_maps_api_key?.configured}
                                    className="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border border-rose-400/30 bg-rose-500/15 text-rose-100 disabled:opacity-60"
                                >
                                    {l('Clear', 'Sterge')}
                                </button>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                <div className="glass-light p-3 rounded-2xl border border-white/10">
                                    <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{l('Price / 1000', 'Pret / 1000')}</div>
                                    <div className="text-sm font-black text-white mt-1">{Number(mapsProviderStatus?.pricing_per_1000 || 0).toFixed(2)} RON</div>
                                </div>
                                <div className="glass-light p-3 rounded-2xl border border-white/10">
                                    <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{l('Credit', 'Credit')}</div>
                                    <div className="text-sm font-black text-white mt-1">{Number(mapsProviderStatus?.platform_credit_balance || 0).toFixed(2)} RON</div>
                                </div>
                                <div className="glass-light p-3 rounded-2xl border border-white/10">
                                    <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{l('Usage', 'Consum')}</div>
                                    <div className="text-sm font-black text-white mt-1">{Number(mapsProviderStatus?.platform_usage_requests || 0)}</div>
                                </div>
                                <div className="glass-light p-3 rounded-2xl border border-white/10">
                                    <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{l('Remaining req.', 'Req. ramase')}</div>
                                    <div className="text-sm font-black text-white mt-1">
                                        {Number.isFinite(Number(mapsProviderStatus?.platform_remaining_estimated_requests))
                                            ? Number(mapsProviderStatus.platform_remaining_estimated_requests)
                                            : '--'}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                    {l('Top-up amount (RON)', 'Suma incarcare (RON)')}
                                    <input
                                        value={mapsTopupAmount}
                                        onChange={(e) => setMapsTopupAmount(e.target.value)}
                                        placeholder="100"
                                        className="mt-1 w-full px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                                    />
                                </label>
                                <button
                                    type="button"
                                    onClick={topupMapsCredit}
                                    disabled={mapsProviderBusy}
                                    className="md:mt-[20px] min-h-[48px] px-4 py-3 rounded-xl bg-emerald-600/80 hover:bg-emerald-500 text-white font-black uppercase tracking-wider border border-emerald-400/30 disabled:opacity-60"
                                >
                                    {l('Top Up', 'Incarca credit')}
                                </button>
                            </div>

                            <button
                                type="button"
                                onClick={saveMapsProviderConfig}
                                disabled={mapsProviderBusy}
                                className="w-full min-h-[52px] btn-premium py-3 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {mapsProviderBusy ? <Loader2 className="animate-spin" size={18} /> : <ShieldCheck size={18} />}
                                {l('Save Maps Config', 'Salveaza configuratia Maps')}
                            </button>

                            {mapsProviderMsg ? (
                                <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-200 text-xs font-bold">
                                    {mapsProviderMsg}
                                </div>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}

                {settingsSections.map((section, sIdx) => (
                    <motion.div key={sIdx} variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {section.title}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent">
                            {section.items.map((item, iIdx) => {
                                const Icon = item.icon;
                                const isClickable = typeof item.onClick === 'function' && !Boolean(item.disabled);
                                const rowClass = `w-full min-h-[72px] p-4 flex items-center gap-4 transition-all group ${iIdx < section.items.length - 1 ? 'border-b border-white/5' : ''}`;

                                if (!isClickable) {
                                    return (
                                        <div
                                            key={iIdx}
                                            className={rowClass}
                                        >
                                            <div className={`p-3 ${getIconBg(item.color)} rounded-xl`}>
                                                {item.loading
                                                    ? <Loader2 className="animate-spin text-slate-400" size={20} strokeWidth={2} />
                                                    : <Icon className={getIconColor(item.color)} size={20} strokeWidth={2} />
                                                }
                                            </div>
                                            <span className="flex-1 text-left font-bold text-white text-sm">{item.label}</span>
                                            {item.value && (
                                                <span className="text-sm text-slate-400 font-semibold text-right max-w-[55%]">
                                                    {item.value}
                                                </span>
                                            )}
                                        </div>
                                    );
                                }

                                return (
                                    <button
                                        key={iIdx}
                                        type="button"
                                        onClick={item.onClick}
                                        disabled={Boolean(item.disabled)}
                                        className={`${rowClass} hover:bg-white/5 active:scale-[0.99]`}
                                    >
                                        <div className={`p-3 ${getIconBg(item.color)} rounded-xl group-hover:scale-110 transition-transform`}>
                                            {item.loading
                                                ? <Loader2 className="animate-spin text-slate-400" size={20} strokeWidth={2} />
                                                : <Icon className={getIconColor(item.color)} size={20} strokeWidth={2} />
                                            }
                                        </div>
                                        <span className="flex-1 text-left font-bold text-white text-sm">{item.label}</span>
                                        {item.value && (
                                            <span className="text-sm text-slate-400 font-semibold">{item.value}</span>
                                        )}
                                        <ChevronRight className="text-slate-500 group-hover:text-violet-400 group-hover:translate-x-1 transition-all" size={18} />
                                    </button>
                                );
                            })}
                        </div>
                    </motion.div>
                ))}

                {cacheMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {cacheMsg}
                    </motion.div>
                )}

                {postisMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {postisMsg}
                    </motion.div>
                )}

                {driversMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {driversMsg}
                    </motion.div>
                )}

                {premiumMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-amber-500/30 text-amber-100 text-xs font-bold"
                    >
                        {premiumMsg}
                    </motion.div>
                )}

                {themeMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-violet-500/30 text-violet-100 text-xs font-bold"
                    >
                        {themeMsg}
                    </motion.div>
                )}

                {/* Premium Feature Card */}
                {isAdmin ? (
                    <motion.button
                        type="button"
                        variants={itemVariants}
                        onClick={togglePremium}
                        className="w-full text-left glass-strong p-5 rounded-2xl border-iridescent relative overflow-hidden group"
                    >
                        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-amber-600/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <div className="relative z-10 flex items-center gap-4">
                            <div className="p-3 bg-gradient-to-br from-amber-500 to-amber-600 rounded-xl shadow-glow-sm">
                                <Sparkles size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white text-sm">{l('Premium Features', 'Functii Premium')}</h3>
                                <p className="text-[10px] text-slate-400 font-medium mt-1">
                                    {l('Unlock advanced analytics & insights', 'Deblocheaza analitice avansate si insight-uri')}
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${premiumState?.enabled
                                        ? 'bg-emerald-500/20 text-emerald-200 border-emerald-300/30'
                                        : 'bg-slate-900/40 text-slate-300 border-white/10'
                                        }`}>
                                        {premiumState?.enabled ? l('Enabled', 'Activat') : l('Disabled', 'Dezactivat')}
                                    </span>
                                    <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${canReadAnalytics
                                        ? 'bg-violet-500/20 text-violet-200 border-violet-300/30'
                                        : 'bg-rose-500/20 text-rose-200 border-rose-300/30'
                                        }`}>
                                        {canReadAnalytics ? l('Analytics access: yes', 'Acces analitice: da') : l('Analytics access: no', 'Acces analitice: nu')}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-black uppercase tracking-wider text-amber-300">
                                    {premiumState?.enabled ? l('Turn off', 'Opreste') : l('Turn on', 'Porneste')}
                                </span>
                                <ChevronRight className="text-amber-400" size={20} />
                            </div>
                        </div>
                    </motion.button>
                ) : null}

                {/* Logout Button */}
                <motion.button
                    variants={itemVariants}
                    onClick={handleLogout}
                    whileTap={{ scale: 0.98 }}
                    className="w-full btn-premium py-4 bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-400 hover:to-rose-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-glow-md transition-all"
                >
                    <LogOut size={20} strokeWidth={2.5} />
                    {l('Sign Out', 'Deconectare')}
                </motion.button>
            </div>

            {/* Footer */}
            <motion.div variants={itemVariants} className="p-6 text-center relative z-10">
                <p className="text-[10px] text-slate-500 font-medium">{l('Powered by Postis Bridge', 'Propulsat de Postis Bridge')}</p>
                <p className="text-[9px] text-slate-600 font-medium mt-1">© 2026 Curieru</p>
            </motion.div>
        </motion.div>
    );
}
