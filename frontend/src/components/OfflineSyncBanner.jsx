import React, { useEffect, useMemo, useState } from 'react';
import { CloudOff, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isBackendForcedOnline } from '../services/api';
import { QUEUE_UPDATED_EVENT, getQueueStats, syncQueue } from '../store/queue';

export default function OfflineSyncBanner() {
    const { user } = useAuth();
    const backendForcedOnline = isBackendForcedOnline();
    const [online, setOnline] = useState(() => {
        if (typeof navigator === 'undefined') return true;
        return navigator.onLine !== false;
    });
    const [stats, setStats] = useState({ total: 0, pending: 0, synced: 0, failed: 0 });
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    const token = user?.token || (() => {
        try {
            return localStorage.getItem('token');
        } catch {
            return null;
        }
    })();

    const refreshStats = async () => {
        try {
            const data = await getQueueStats();
            setStats(data || { total: 0, pending: 0, synced: 0, failed: 0 });
        } catch {
            setStats({ total: 0, pending: 0, synced: 0, failed: 0 });
        }
    };

    useEffect(() => {
        void refreshStats();

        const onOnline = () => setOnline(true);
        const onOffline = () => setOnline(false);
        const onQueue = () => { void refreshStats(); };

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        window.addEventListener(QUEUE_UPDATED_EVENT, onQueue);

        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            window.removeEventListener(QUEUE_UPDATED_EVENT, onQueue);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const visible = !backendForcedOnline && (!online || Number(stats?.pending || 0) > 0 || Number(stats?.failed || 0) > 0);
    const pending = Number(stats?.pending || 0);
    const failed = Number(stats?.failed || 0);

    const title = useMemo(() => {
        if (!online) return 'Offline mode activ';
        if (pending > 0) return `${pending} actualizari in asteptare`;
        if (failed > 0) return `${failed} actualizari necesita re-sync`;
        return '';
    }, [online, pending, failed]);

    const detail = useMemo(() => {
        if (!online) return 'Poti lucra local. Modificarile se salveaza pe dispozitiv si se sincronizeaza automat cand revine internetul.';
        if (pending > 0) return 'Aplicatia incearca sincronizarea automata. Poti forta acum cu butonul Sync.';
        if (failed > 0) return 'Unele actualizari nu au fost trimise inca. Reincearca sincronizarea.';
        return '';
    }, [online, pending, failed]);

    const handleSync = async () => {
        if (!token || busy) return;
        setBusy(true);
        setMsg('');
        try {
            const res = await syncQueue(token);
            const synced = Number(res?.synced || 0);
            const left = Number(res?.pending || 0);
            setMsg(synced > 0 ? `Sincronizate ${synced} actualizari. Ramase: ${left}.` : 'Nu exista actualizari noi de sincronizat.');
            await refreshStats();
        } catch (e) {
            setMsg(String(e?.message || 'Sincronizarea a esuat.'));
        } finally {
            setBusy(false);
        }
    };

    if (!visible) return null;

    return (
        <div className="px-4 pt-3">
            <div className={`glass-strong rounded-3xl border p-4 flex items-start gap-3 ${!online
                ? 'border-amber-500/25 bg-amber-500/10'
                : 'border-cyan-500/25 bg-cyan-500/10'}`}
            >
                <div className={`w-10 h-10 rounded-2xl border flex items-center justify-center flex-shrink-0 ${!online
                    ? 'bg-amber-500/15 border-amber-500/20 text-amber-300'
                    : 'bg-cyan-500/15 border-cyan-500/20 text-cyan-300'}`}
                >
                    {!online ? <WifiOff size={18} /> : (pending > 0 ? <CloudOff size={18} /> : <Wifi size={18} />)}
                </div>

                <div className="flex-1 min-w-0">
                    <p className={`text-[10px] uppercase tracking-[0.2em] font-black ${!online ? 'text-amber-200/90' : 'text-cyan-200/90'}`}>{title}</p>
                    <p className={`text-xs font-bold mt-1 ${!online ? 'text-amber-100' : 'text-cyan-100'}`}>{detail}</p>
                    {msg ? (
                        <p className={`text-[10px] font-bold mt-2 ${!online ? 'text-amber-200/80' : 'text-cyan-200/80'}`}>{msg}</p>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={handleSync}
                    disabled={!online || !token || busy}
                    className={`px-3 py-2 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all ${(!online || !token || busy)
                        ? 'opacity-60 cursor-not-allowed border-white/10 text-slate-400'
                        : 'bg-emerald-500/15 border-emerald-500/25 text-emerald-100 hover:bg-emerald-500/25'}`}
                    title="Sincronizeaza acum"
                >
                    <span className="inline-flex items-center gap-2">
                        <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Sync
                    </span>
                </button>
            </div>
        </div>
    );
}
