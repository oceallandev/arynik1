import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Loader2, MessageCircle, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { normalizeRole, ROLE_DRIVER, ROLE_RECIPIENT } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { ensureChatThread, getShipments, listChatThreads } from '../services/api';

const toDateInputValue = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const resolvePresetRange = (preset) => {
    const now = new Date();
    const endDate = toDateInputValue(now);
    if (preset === 'all') return { startDate: '', endDate: '' };
    const start = new Date(now);
    if (preset === 'today') {
        // no-op
    } else if (preset === '7d') {
        start.setDate(start.getDate() - 6);
    } else if (preset === '30d') {
        start.setDate(start.getDate() - 29);
    } else {
        start.setDate(1);
    }
    return { startDate: toDateInputValue(start), endDate };
};

const PERIOD_OPTIONS = [
    { key: 'today', label: 'Astazi' },
    { key: '7d', label: '7 zile' },
    { key: '30d', label: '30 zile' },
    { key: 'month', label: 'Luna curenta' },
    { key: 'all', label: 'Toate' },
];

const fmtDateTime = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '--';
        return d.toLocaleString();
    } catch {
        return '--';
    }
};

const dayKey = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return 'unknown';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
        return 'unknown';
    }
};

const fmtDayLabel = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return 'Data necunoscuta';
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diff = Math.round((today - target) / (24 * 60 * 60 * 1000));
        if (diff === 0) return 'Astazi';
        if (diff === 1) return 'Ieri';
        return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return 'Data necunoscuta';
    }
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();
const COMPANY_HINT_RE = /\b(srl|s\.r\.l|sa|s\.a|pfa|ii|if|company|corp|inc|ltd|llc|gmbh)\b/i;

const hasMeaningfulName = (value) => {
    const text = String(value || '').trim();
    if (!text) return false;
    const low = text.toLowerCase();
    return !['unknown', 'necunoscut', 'recipient', 'destinatar', 'customer', 'client'].includes(low);
};

const shipmentRecipientName = (shipment) => {
    if (!shipment || typeof shipment !== 'object') return '';
    const raw = shipment?.raw_data || {};
    const candidates = [
        shipment?.recipient_name,
        raw?.recipientName,
        raw?.recipient?.name,
        raw?.recipient?.fullName,
        raw?.recipient?.companyName,
        raw?.recipientCompanyName,
    ];
    for (const c of candidates) {
        const txt = String(c || '').trim();
        if (hasMeaningfulName(txt)) return txt;
    }
    return '';
};

const shipmentRecipientType = (shipment) => {
    if (!shipment || typeof shipment !== 'object') return 'client_final';
    const raw = shipment?.raw_data || {};

    const companyFlags = [
        raw?.recipient?.isCompany,
        raw?.recipient?.is_company,
        raw?.recipientIsCompany,
    ];
    if (companyFlags.some((v) => v === true || v === 1 || String(v || '').trim().toLowerCase() === 'true')) {
        return 'client_b2b';
    }

    const maybeCompanyFields = [
        shipment?.recipient_name,
        raw?.recipientName,
        raw?.recipient?.name,
        raw?.recipient?.companyName,
        raw?.recipientCompanyName,
    ];
    if (maybeCompanyFields.some((v) => COMPANY_HINT_RE.test(String(v || '').trim()))) {
        return 'client_b2b';
    }
    return 'client_final';
};

const deriveCounterparty = ({ role, shipment, awb }) => {
    const ship = shipment || null;
    const driverId = String(ship?.driver_id || '').trim().toUpperCase();
    const recipientName = String(ship?.recipient_name || '').trim();
    const recipientPhone = String(ship?.recipient_phone || '').trim();

    if (role === ROLE_RECIPIENT) {
        if (driverId) return { key: `driver:${driverId}`, label: `Sofer ${driverId}`, role: ROLE_DRIVER };
        return { key: 'ops:team', label: 'Echipa operare', role: 'Internal' };
    }

    if (role === ROLE_DRIVER) {
        if (recipientName) return { key: `recipient:${recipientName.toLowerCase()}`, label: recipientName, role: ROLE_RECIPIENT };
        if (recipientPhone) return { key: `recipient:${recipientPhone}`, label: recipientPhone, role: ROLE_RECIPIENT };
        return { key: 'dispatch:team', label: 'Dispecerat', role: 'Internal' };
    }

    // Fallback for internal staff (Admin, Manager, Dispatcher)
    if (driverId && recipientName) {
        return { key: `driver:${driverId}`, label: `Sofer ${driverId} (Client: ${recipientName})`, role: ROLE_DRIVER };
    }
    if (driverId) return { key: `driver:${driverId}`, label: `Sofer ${driverId}`, role: ROLE_DRIVER };
    if (recipientName) return { key: `recipient:${recipientName.toLowerCase()}`, label: recipientName, role: ROLE_RECIPIENT };
    return { key: `thread:${String(awb || 'unknown').toLowerCase()}`, label: 'Echipa interna', role: 'Internal' };
};

const deriveThreadMeta = ({ thread, shipment, currentRole }) => {
    const role = normalizeRole(currentRole);
    const awb = String(thread?.awb || '').trim().toUpperCase();
    const createdAt = thread?.last_message_at || thread?.created_at || null;
    const createdTs = createdAt ? new Date(createdAt).getTime() : 0;
    const unread = Number(thread?.unread_count || 0);
    const clientName = shipmentRecipientName(shipment);
    const subject = String(thread?.subject || '').trim();

    const counterparty = deriveCounterparty({ role, shipment, awb });
    const scope = (role === ROLE_RECIPIENT || counterparty.role === ROLE_RECIPIENT)
        ? { key: 'external', label: 'Extern' }
        : { key: 'internal', label: 'Intern' };

    const recipientKind = shipmentRecipientType(shipment);
    const userType = counterparty.role === ROLE_RECIPIENT
        ? (recipientKind === 'client_b2b'
            ? { key: 'client_b2b', label: 'Client B2B' }
            : { key: 'client_final', label: 'Client final' })
        : (counterparty.role === ROLE_DRIVER
            ? { key: 'driver', label: 'Sofer' }
            : { key: 'internal', label: 'Intern' });

    const commType = awb
        ? { key: 'awb_chat', label: 'Chat livrare' }
        : { key: 'internal_chat', label: 'Chat intern' };

    const threadLabel = awb
        ? (clientName ? `${clientName} • ${awb}` : awb)
        : (subject || counterparty.label || 'Chat');

    const searchBlob = [
        awb,
        threadLabel,
        clientName,
        thread?.subject,
        thread?.last_message_preview,
        counterparty.label,
        userType.label,
        commType.label
    ].map((x) => String(x || '')).join(' ').toLowerCase();

    return {
        thread,
        awb,
        createdAt,
        createdTs: Number.isFinite(createdTs) ? createdTs : 0,
        unread,
        counterparty,
        clientName,
        userType,
        commType,
        scope,
        threadLabel,
        searchBlob,
    };
};

export default function ChatInbox() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const currentRole = normalizeRole(user?.role);
    const isRecipient = currentRole === ROLE_RECIPIENT;

    const [threads, setThreads] = useState([]);
    const [shipmentsByAwb, setShipmentsByAwb] = useState({});
    const [loading, setLoading] = useState(true);
    const [contextLoading, setContextLoading] = useState(false);
    const [error, setError] = useState('');
    const [contextError, setContextError] = useState('');
    const [awb, setAwb] = useState('');
    const [busyOpen, setBusyOpen] = useState(false);

    const [search, setSearch] = useState('');
    const [scopeFilter, setScopeFilter] = useState('all');
    const [userTypeFilter, setUserTypeFilter] = useState('all');
    const [withFilter, setWithFilter] = useState('all');
    const [readFilter, setReadFilter] = useState('all'); // all | unread | read
    const [groupBy, setGroupBy] = useState('user_type'); // date | with | user_type | scope
    const [periodPreset, setPeriodPreset] = useState('30d');
    const [startDate, setStartDate] = useState(() => resolvePresetRange('30d').startDate);
    const [endDate, setEndDate] = useState(() => resolvePresetRange('30d').endDate);

    const applyPeriodPreset = (preset) => {
        const next = resolvePresetRange(preset);
        setPeriodPreset(preset);
        setStartDate(next.startDate);
        setEndDate(next.endDate);
    };

    const onChangeStartDate = (value) => {
        setPeriodPreset('custom');
        setStartDate(String(value || ''));
    };

    const onChangeEndDate = (value) => {
        setPeriodPreset('custom');
        setEndDate(String(value || ''));
    };

    const refreshThreads = async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        try {
            const data = await listChatThreads(token, { limit: 100 });
            setThreads(Array.isArray(data) ? data : []);
        } catch (e) {
            setThreads([]);
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load chat'));
        } finally {
            setLoading(false);
        }
    };

    const refreshContext = async ({ quiet = false } = {}) => {
        if (!token) return;
        if (!quiet) setContextLoading(true);
        setContextError('');
        try {
            const shipments = await getShipments(token);
            const map = {};
            (Array.isArray(shipments) ? shipments : []).forEach((s) => {
                const key = String(s?.awb || '').trim().toUpperCase();
                if (!key) return;
                map[key] = s;
            });
            setShipmentsByAwb(map);
        } catch (e) {
            setContextError(String(e?.response?.data?.detail || e?.message || 'Nu pot incarca contextul AWB pentru chat.'));
        } finally {
            if (!quiet) setContextLoading(false);
        }
    };

    useEffect(() => {
        void refreshThreads();
        void refreshContext({ quiet: false });
        if (!token) return undefined;
        const threadsId = setInterval(() => {
            void refreshThreads();
        }, 15000);
        const contextId = setInterval(() => {
            void refreshContext({ quiet: true });
        }, 120000);
        return () => {
            clearInterval(threadsId);
            clearInterval(contextId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const openByAwb = async () => {
        if (!token) return;
        const key = String(awb || '').trim().toUpperCase();
        if (!key) return;
        setBusyOpen(true);
        setError('');
        try {
            const t = await ensureChatThread(token, { awb: key });
            if (t?.id) {
                navigate(`/chat/${encodeURIComponent(String(t.id))}`);
            } else {
                setError('Nu am putut deschide chatul');
            }
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to open chat'));
        } finally {
            setBusyOpen(false);
        }
    };

    const normalized = useMemo(() => {
        return (Array.isArray(threads) ? threads : [])
            .map((thread) => {
                const awbKey = String(thread?.awb || '').trim().toUpperCase();
                const ship = awbKey ? shipmentsByAwb[awbKey] : null;
                return deriveThreadMeta({ thread, shipment: ship, currentRole });
            })
            .sort((a, b) => b.createdTs - a.createdTs);
    }, [currentRole, shipmentsByAwb, threads]);

    const unreadTotal = useMemo(() => {
        return normalized.reduce((acc, x) => acc + (Number(x?.unread) || 0), 0);
    }, [normalized]);

    const withOptions = useMemo(() => {
        const map = new Map();
        normalized.forEach((x) => {
            const key = String(x?.counterparty?.key || '').trim();
            if (!key) return;
            if (!map.has(key)) map.set(key, x.counterparty.label || key);
        });
        return Array.from(map.entries())
            .map(([key, label]) => ({ key, label }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { sensitivity: 'base' }));
    }, [normalized]);

    const filtered = useMemo(() => {
        const needle = normalizeText(search);
        const startTs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
        const endTs = endDate ? new Date(`${endDate}T23:59:59`).getTime() : null;

        return normalized.filter((x) => {
            if (scopeFilter !== 'all' && x.scope.key !== scopeFilter) return false;
            if (userTypeFilter !== 'all' && x.userType.key !== userTypeFilter) return false;
            if (withFilter !== 'all' && x.counterparty.key !== withFilter) return false;
            if (readFilter === 'unread' && x.unread <= 0) return false;
            if (readFilter === 'read' && x.unread > 0) return false;
            if (needle && !x.searchBlob.includes(needle)) return false;
            if (Number.isFinite(startTs) && x.createdTs < startTs) return false;
            if (Number.isFinite(endTs) && x.createdTs > endTs) return false;
            return true;
        });
    }, [endDate, normalized, readFilter, scopeFilter, search, startDate, userTypeFilter, withFilter]);

    const grouped = useMemo(() => {
        const byKey = new Map();
        filtered.forEach((x) => {
            let key = '';
            let label = '';
            if (groupBy === 'with') {
                key = `with:${x.counterparty.key}`;
                label = x.counterparty.label;
            } else if (groupBy === 'user_type') {
                key = `user:${x.userType.key}`;
                label = x.userType.label;
            } else if (groupBy === 'scope') {
                key = `scope:${x.scope.key}`;
                label = x.scope.label;
            } else {
                key = `date:${dayKey(x.createdAt)}`;
                label = fmtDayLabel(x.createdAt);
            }
            const row = byKey.get(key) || { key, label, sortTs: 0, items: [] };
            row.items.push(x);
            row.sortTs = Math.max(row.sortTs, Number(x.createdTs || 0));
            byKey.set(key, row);
        });

        const out = Array.from(byKey.values());
        out.forEach((section) => {
            section.items.sort((a, b) => b.createdTs - a.createdTs);
        });
        if (groupBy === 'user_type') {
            const order = {
                'user:client_final': 0,
                'user:client_b2b': 1,
                'user:driver': 2,
                'user:internal': 3,
            };
            out.sort((a, b) => {
                const ao = Number.isFinite(order[a.key]) ? order[a.key] : 99;
                const bo = Number.isFinite(order[b.key]) ? order[b.key] : 99;
                if (ao !== bo) return ao - bo;
                return b.sortTs - a.sortTs;
            });
            return out;
        }
        if (groupBy === 'scope') {
            const order = {
                'scope:external': 0,
                'scope:internal': 1,
            };
            out.sort((a, b) => {
                const ao = Number.isFinite(order[a.key]) ? order[a.key] : 99;
                const bo = Number.isFinite(order[b.key]) ? order[b.key] : 99;
                if (ao !== bo) return ao - bo;
                return b.sortTs - a.sortTs;
            });
            return out;
        }
        out.sort((a, b) => b.sortTs - a.sortTs);
        return out;
    }, [filtered, groupBy]);

    const internalCount = useMemo(() => filtered.filter((x) => x.scope.key === 'internal').length, [filtered]);
    const externalCount = useMemo(() => filtered.filter((x) => x.scope.key === 'external').length, [filtered]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="min-w-0">
                    <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                        <MessageCircle size={18} className="text-violet-300" />
                        Chat
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                        {unreadTotal} necitite • {filtered.length} conversatii vizibile
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => { void refreshThreads(); void refreshContext({ quiet: true }); }}
                    className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={loading}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-3 relative z-10">
                {!isRecipient ? (
                    <div className="glass-strong p-4 rounded-3xl border border-white/10 space-y-3">
                        <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Deschide chat dupa AWB</div>
                        <div className="flex items-center gap-2">
                            <div className="flex-1 flex items-center gap-2 glass-light rounded-2xl border border-white/10 px-3 py-3">
                                <Search size={16} className="text-slate-500" />
                                <input
                                    value={awb}
                                    onChange={(e) => setAwb(e.target.value)}
                                    placeholder="Introdu AWB (ex. AWB123...)"
                                    className="w-full bg-transparent outline-none text-sm font-bold text-white placeholder:text-slate-600"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={openByAwb}
                                disabled={busyOpen}
                                className={`w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all flex items-center justify-center ${busyOpen ? 'opacity-60 cursor-not-allowed' : ''}`}
                                title="Deschide"
                            >
                                {busyOpen ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="glass-strong p-4 rounded-3xl border border-white/10">
                        <div className="text-[11px] font-bold text-slate-300">
                            Deschide coletul din Track si apasa Chat pentru a trimite mesaje sau locatia exacta de livrare.
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Vizibile</div>
                        <div className="text-sm font-black text-white mt-1">{filtered.length}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Necitite</div>
                        <div className="text-sm font-black text-white mt-1">{unreadTotal}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Interne</div>
                        <div className="text-sm font-black text-white mt-1">{internalCount}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Externe</div>
                        <div className="text-sm font-black text-white mt-1">{externalCount}</div>
                    </div>
                </div>

                <div className="glass-strong rounded-3xl border border-white/10 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-400 font-black">
                        <SlidersHorizontal size={13} /> Filtrare & grupare chat
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {PERIOD_OPTIONS.map((opt) => (
                            <button
                                key={opt.key}
                                type="button"
                                onClick={() => applyPeriodPreset(opt.key)}
                                className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-wide transition-all ${periodPreset === opt.key
                                    ? 'bg-violet-500/20 border border-violet-400/40 text-violet-100'
                                    : 'bg-slate-900/35 border border-white/10 text-slate-300 hover:bg-white/10'
                                    }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            De la
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => onChangeStartDate(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            />
                        </label>
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Pana la
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => onChangeEndDate(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            />
                        </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Cauta
                            <div className="mt-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10">
                                <Search size={14} className="text-slate-500" />
                                <input
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="AWB, mesaj, persoana..."
                                    className="w-full bg-transparent text-white text-sm outline-none placeholder:text-slate-600"
                                />
                            </div>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Comunicare
                            <select
                                value={scopeFilter}
                                onChange={(e) => setScopeFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="all">Interne + externe</option>
                                <option value="internal">Interne</option>
                                <option value="external">Externe</option>
                            </select>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Tip utilizator
                            <select
                                value={userTypeFilter}
                                onChange={(e) => setUserTypeFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="all">Toate tipurile</option>
                                <option value="client_final">Client final</option>
                                <option value="client_b2b">Client B2B</option>
                                <option value="driver">Sofer</option>
                                <option value="internal">Intern</option>
                            </select>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Cu cine
                            <select
                                value={withFilter}
                                onChange={(e) => setWithFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="all">Toate persoanele</option>
                                {withOptions.map((opt) => (
                                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                                ))}
                            </select>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Grupare
                            <select
                                value={groupBy}
                                onChange={(e) => setGroupBy(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="date">Dupa data</option>
                                <option value="with">Dupa persoana</option>
                                <option value="user_type">Dupa tip utilizator</option>
                                <option value="scope">Dupa comunicare</option>
                            </select>
                        </label>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setReadFilter('all')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${readFilter === 'all'
                                ? 'bg-emerald-500/20 border-emerald-500/35 text-emerald-100'
                                : 'bg-slate-900/35 border-white/10 text-slate-300'
                                }`}
                        >
                            Toate
                        </button>
                        <button
                            type="button"
                            onClick={() => setReadFilter('unread')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${readFilter === 'unread'
                                ? 'bg-amber-500/20 border-amber-400/35 text-amber-100'
                                : 'bg-slate-900/35 border-white/10 text-slate-300'
                                }`}
                        >
                            Doar necitite
                        </button>
                        <button
                            type="button"
                            onClick={() => setReadFilter('read')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${readFilter === 'read'
                                ? 'bg-sky-500/20 border-sky-400/35 text-sky-100'
                                : 'bg-slate-900/35 border-white/10 text-slate-300'
                                }`}
                        >
                            Doar citite
                        </button>
                    </div>
                </div>

                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                {contextError ? (
                    <div className="glass-strong p-4 rounded-2xl border border-amber-500/30 text-amber-200 text-xs font-bold">
                        {contextError}
                    </div>
                ) : null}

                {loading || contextLoading ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 flex items-center gap-3 text-slate-300">
                        <Loader2 className="animate-spin" size={18} />
                        <span className="text-sm font-bold">Loading...</span>
                    </div>
                ) : null}

                {!loading && !contextLoading && grouped.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <MessageCircle className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">Nu exista conversatii pentru filtrele alese</p>
                        <p className="text-sm mt-2 text-slate-500">
                            {isRecipient ? 'Incearca alta perioada sau alt tip utilizator' : 'Poti deschide si un chat nou dupa AWB'}
                        </p>
                    </div>
                ) : null}

                {!loading && grouped.length > 0 ? (
                    grouped.map((section) => (
                        <div key={section.key} className="space-y-2">
                            <div className="px-1 flex items-center justify-between">
                                <p className="text-[10px] text-violet-300 font-black uppercase tracking-[0.16em]">
                                    {section.label}
                                </p>
                                <span className="text-[10px] text-slate-500 font-black uppercase tracking-wider">
                                    {section.items.length} chat-uri
                                </span>
                            </div>
                            <div className="space-y-2">
                                {section.items.map((x) => {
                                    const t = x.thread;
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            onClick={() => navigate(`/chat/${encodeURIComponent(String(t.id))}`)}
                                            className="w-full text-left glass-strong p-4 rounded-3xl border border-white/10 hover:bg-white/5 transition-all"
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="text-sm font-black text-white truncate">
                                                            {x.threadLabel}
                                                        </p>
                                                        <span className={`px-2 py-1 rounded-full border text-[9px] font-black uppercase tracking-wider ${x.scope.key === 'external'
                                                            ? 'bg-amber-500/15 border-amber-500/30 text-amber-200'
                                                            : 'bg-sky-500/15 border-sky-500/30 text-sky-200'
                                                            }`}>
                                                            {x.scope.label}
                                                        </span>
                                                        <span className="px-2 py-1 rounded-full border border-white/15 bg-white/5 text-[9px] font-black uppercase tracking-wider text-slate-300">
                                                            {x.userType.label}
                                                        </span>
                                                        <span className="px-2 py-1 rounded-full border border-white/15 bg-white/5 text-[9px] font-black uppercase tracking-wider text-slate-300">
                                                            {x.commType.label}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-slate-400 font-bold mt-1">
                                                        Cu: {x.counterparty.label}
                                                    </p>
                                                    <p className="text-xs text-slate-300 font-medium mt-2 break-words">
                                                        {String(t?.last_message_preview || 'Fara mesaje inca')}
                                                    </p>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2">
                                                        {fmtDateTime(t?.last_message_at || t?.created_at)}
                                                    </p>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    {x.unread > 0 ? (
                                                        <div className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest">
                                                            {x.unread}
                                                        </div>
                                                    ) : null}
                                                    <div className="w-10 h-10 rounded-2xl glass-light border border-white/10 flex items-center justify-center text-slate-400">
                                                        <ArrowRight size={18} />
                                                    </div>
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))
                ) : null}
            </main>
        </motion.div>
    );
}
