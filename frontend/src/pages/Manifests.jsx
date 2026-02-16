import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ClipboardList, Plus, RefreshCw, ScanLine, X, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { hasPermission } from '../auth/rbac';
import { PERM_MANIFESTS_READ, PERM_MANIFESTS_WRITE } from '../auth/permissions';
import Scanner from '../components/Scanner';
import { closeManifest, createManifest, getManifest, listManifests, scanManifest } from '../services/api';

const fmtDateTime = (iso) => {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return '';
    }
};

const completenessLabel = (item) => {
    const expected = Number(item?.parcels_total);
    const scannedParcels = Array.isArray(item?.scanned_parcel_indexes) ? item.scanned_parcel_indexes.length : 0;
    const scans = Number(item?.scan_count) || 0;
    if (Number.isFinite(expected) && expected > 0) {
        return `${scannedParcels}/${expected}`;
    }
    return scans ? `${scans} scan` : '—';
};

export default function Manifests() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const canRead = hasPermission(user, PERM_MANIFESTS_READ);
    const canWrite = hasPermission(user, PERM_MANIFESTS_WRITE);

    const [manifests, setManifests] = useState([]);
    const [active, setActive] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const [createForm, setCreateForm] = useState({
        truck_plate: user?.truck_plate || '',
        date: new Date().toISOString().slice(0, 10),
        kind: 'loadout',
        notes: ''
    });

    const [manualScan, setManualScan] = useState('');
    const [scannerOpen, setScannerOpen] = useState(false);

    const refresh = async () => {
        if (!token || !canRead) return;
        setLoading(true);
        setError('');
        try {
            const data = await listManifests(token, { limit: 50 });
            setManifests(Array.isArray(data) ? data : []);
        } catch (e) {
            setManifests([]);
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load manifests'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, canRead]);

    const openManifest = async (id) => {
        if (!token) return;
        setBusy(true);
        setError('');
        try {
            const data = await getManifest(token, id);
            setActive(data || null);
        } catch (e) {
            setActive(null);
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to open manifest'));
        } finally {
            setBusy(false);
        }
    };

    const submitCreate = async () => {
        if (!token || !canWrite) return;
        setBusy(true);
        setError('');
        try {
            const data = await createManifest(token, {
                truck_plate: String(createForm.truck_plate || '').trim().toUpperCase() || undefined,
                date: String(createForm.date || '').trim() || undefined,
                kind: String(createForm.kind || 'loadout'),
                notes: String(createForm.notes || '').trim() || undefined,
            });
            setActive(data || null);
            await refresh();
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to create manifest'));
        } finally {
            setBusy(false);
        }
    };

    const doScan = async (identifier) => {
        if (!token || !active?.id || !identifier) return;
        setBusy(true);
        setError('');
        try {
            await scanManifest(token, active.id, { identifier: String(identifier).trim() });
            const updated = await getManifest(token, active.id);
            setActive(updated || active);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Scan failed'));
        } finally {
            setBusy(false);
        }
    };

    const close = async () => {
        if (!token || !active?.id || !canWrite) return;
        setBusy(true);
        setError('');
        try {
            const updated = await closeManifest(token, active.id, { notes: String(active?.notes || '').trim() || undefined });
            setActive(updated || null);
            await refresh();
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to close manifest'));
        } finally {
            setBusy(false);
        }
    };

    const activeItems = useMemo(() => (
        Array.isArray(active?.items) ? active.items.slice().sort((a, b) => String(a?.awb || '').localeCompare(String(b?.awb || ''))) : []
    ), [active?.items]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="min-w-0">
                    <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                        <ClipboardList size={18} className="text-emerald-300" />
                        Manifests
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                        Load-out and return scanning
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={refresh}
                        disabled={loading}
                        className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                        aria-label="Refresh"
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                    {active ? (
                        <button
                            type="button"
                            onClick={() => setActive(null)}
                            className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all"
                            aria-label="Close"
                            title="Back to list"
                        >
                            <X size={18} />
                        </button>
                    ) : null}
                </div>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-4 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                {!active ? (
                    <>
                        {canWrite ? (
                            <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                                <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Create manifest</div>
                                <div className="grid grid-cols-2 gap-3">
                                    <input
                                        value={createForm.truck_plate}
                                        onChange={(e) => setCreateForm((p) => ({ ...p, truck_plate: e.target.value }))}
                                        placeholder="Truck plate"
                                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                    />
                                    <input
                                        type="date"
                                        value={createForm.date}
                                        onChange={(e) => setCreateForm((p) => ({ ...p, date: e.target.value }))}
                                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white outline-none"
                                    />
                                    <select
                                        value={createForm.kind}
                                        onChange={(e) => setCreateForm((p) => ({ ...p, kind: e.target.value }))}
                                        className="col-span-2 w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white outline-none text-sm font-bold"
                                    >
                                        <option value="loadout">Load-out</option>
                                        <option value="return">Return</option>
                                    </select>
                                    <input
                                        value={createForm.notes}
                                        onChange={(e) => setCreateForm((p) => ({ ...p, notes: e.target.value }))}
                                        placeholder="Notes (optional)"
                                        className="col-span-2 w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={submitCreate}
                                    disabled={busy}
                                    className={`w-full px-4 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    <Plus size={16} />
                                    Create
                                </button>
                            </div>
                        ) : null}

                        <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                            <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Recent manifests</div>
                            {loading ? (
                                <div className="text-slate-400 text-sm font-bold">Loading…</div>
                            ) : manifests.length === 0 ? (
                                <div className="text-slate-500 text-sm font-bold">No manifests yet.</div>
                            ) : (
                                <div className="space-y-2">
                                    {manifests.map((m) => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => openManifest(m.id)}
                                            className="w-full p-4 rounded-2xl glass-light border border-white/10 hover:bg-white/5 transition-all text-left"
                                            disabled={busy}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="text-sm font-black text-white truncate">
                                                        {m.truck_plate ? String(m.truck_plate).toUpperCase() : 'Unassigned'} • {m.kind}
                                                    </div>
                                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                                        {m.date || ''}{m.created_at ? ` • ${fmtDateTime(m.created_at)}` : ''}
                                                    </div>
                                                </div>
                                                <div className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${String(m.status || '').toLowerCase() === 'closed'
                                                    ? 'bg-slate-900/40 border-white/10 text-slate-400'
                                                    : 'bg-emerald-500/15 border-emerald-500/20 text-emerald-200'
                                                    }`}
                                                >
                                                    {m.status || 'Open'}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-black text-white truncate">
                                        {active.truck_plate ? String(active.truck_plate).toUpperCase() : 'Unassigned'} • {active.kind}
                                    </div>
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                        {active.date || ''}{active.created_at ? ` • ${fmtDateTime(active.created_at)}` : ''}
                                    </div>
                                </div>
                                <div className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${String(active.status || '').toLowerCase() === 'closed'
                                    ? 'bg-slate-900/40 border-white/10 text-slate-400'
                                    : 'bg-emerald-500/15 border-emerald-500/20 text-emerald-200'
                                    }`}
                                >
                                    {active.status || 'Open'}
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setScannerOpen(true)}
                                    disabled={!canWrite || busy || String(active.status || '').toLowerCase() !== 'open'}
                                    className="col-span-1 px-3 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <ScanLine size={16} />
                                    Scan
                                </button>
                                <input
                                    value={manualScan}
                                    onChange={(e) => setManualScan(e.target.value)}
                                    placeholder="Enter barcode..."
                                    className="col-span-2 w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={() => { const v = manualScan; setManualScan(''); doScan(v); }}
                                    disabled={!canWrite || busy || !manualScan.trim() || String(active.status || '').toLowerCase() !== 'open'}
                                    className="col-span-3 px-3 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    Add scan
                                </button>
                            </div>

                            {canWrite && String(active.status || '').toLowerCase() === 'open' ? (
                                <button
                                    type="button"
                                    onClick={close}
                                    disabled={busy}
                                    className={`w-full px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    <CheckCircle2 size={16} />
                                    Close manifest
                                </button>
                            ) : null}
                        </div>

                        <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                            <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                Items ({activeItems.length})
                            </div>
                            {activeItems.length === 0 ? (
                                <div className="text-slate-500 text-sm font-bold">Scan a barcode to start.</div>
                            ) : (
                                <div className="space-y-2">
                                    {activeItems.map((it) => (
                                        <div
                                            key={it.id}
                                            className="glass-light p-4 rounded-2xl border border-white/10 flex items-center justify-between gap-3"
                                        >
                                            <div className="min-w-0">
                                                <div className="text-sm font-black text-white truncate">{String(it.awb || '').toUpperCase()}</div>
                                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                                    Last scan: {it.last_scanned_at ? fmtDateTime(it.last_scanned_at) : '—'}
                                                </div>
                                            </div>
                                            <div className="px-2.5 py-1 rounded-full bg-slate-900/40 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest">
                                                {completenessLabel(it)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {scannerOpen ? (
                            <Scanner
                                onScan={(val) => { setScannerOpen(false); doScan(val); }}
                                onClose={() => setScannerOpen(false)}
                            />
                        ) : null}
                    </>
                )}
            </main>
        </motion.div>
    );
}

