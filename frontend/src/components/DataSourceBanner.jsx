import React, { useEffect, useState } from 'react';
import { AlertTriangle, Settings as SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getDataSource, getDataSourceReason } from '../services/api';

export default function DataSourceBanner() {
    const navigate = useNavigate();
    const [source, setSource] = useState(getDataSource());
    const [reason, setReason] = useState(getDataSourceReason());

    useEffect(() => {
        const onEvt = (e) => {
            const next = e?.detail?.source || getDataSource();
            const nextReason = e?.detail?.reason || getDataSourceReason();
            setSource(next);
            setReason(nextReason);
        };
        window.addEventListener('arynik:data-source', onEvt);
        return () => window.removeEventListener('arynik:data-source', onEvt);
    }, []);

    if (String(source || '').toLowerCase() !== 'snapshot') {
        return null;
    }

    const hint = (() => {
        const r = String(reason || '').trim().toLowerCase();
        if (!r) return 'Backend unreachable.';
        if (r === 'login') return 'Backend unreachable (login).';
        if (r === 'shipments') return 'Backend unreachable (shipments).';
        if (r === 'shipment') return 'Backend unreachable (details).';
        return 'Backend unreachable.';
    })();

    return (
        <div className="px-4 pt-3">
            <div className="glass-strong rounded-3xl border border-amber-500/25 bg-amber-500/10 p-4 flex items-start gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle size={18} className="text-amber-300" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.2em] font-black text-amber-200/90">Offline Snapshot Mode</p>
                    <p className="text-xs font-bold text-amber-100 mt-1">
                        {hint} Live Postis sync and full AWB info require the backend API.
                    </p>
                    <p className="text-[10px] font-bold text-amber-200/70 mt-2">
                        Fix: Menu → Settings → API URL (must be HTTPS on GitHub Pages).
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => navigate('/settings')}
                    className="px-3 py-2 rounded-2xl bg-amber-500/15 border border-amber-500/25 text-amber-100 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2"
                    title="Open Settings"
                >
                    <SettingsIcon size={14} />
                    Settings
                </button>
            </div>
        </div>
    );
}

