import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bell, CalendarDays, Check, Loader2, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import AwbLink from '../components/AwbLink';
import { normalizeRole, ROLE_DRIVER, ROLE_RECIPIENT } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { getNotifications, markNotificationRead } from '../services/api';

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

const isExternalRole = (roleRaw) => {
    const role = normalizeText(roleRaw);
    return role === 'recipient' || role === 'customer' || role === 'client' || role.includes('b2b');
};

const isChatNotification = (n) => {
    const typeRaw = normalizeText(n?.data?.type);
    const title = normalizeText(n?.title);
    return typeRaw === 'chat_message' || title.startsWith('chat:');
};

const typeInfo = (n) => {
    const rawType = normalizeText(n?.data?.type);
    const title = normalizeText(n?.title);
    if (rawType.startsWith('tracking_')) return { key: 'tracking', label: 'Tracking' };
    if (rawType === 'reschedule_request') return { key: 'reschedule', label: 'Reprogramare' };
    if (rawType === 'instructions_update') return { key: 'instructions', label: 'Instructiuni livrare' };
    if (title.includes('allocated') || title.includes('alocat')) return { key: 'allocation', label: 'Alocare livrare' };
    return { key: 'system', label: 'Operational' };
};

const deriveCounterparty = (n, currentRole) => {
    const data = n?.data && typeof n.data === 'object' ? n.data : {};
    const driverId = String(data?.driver_id || '').trim().toUpperCase();
    const driverName = String(data?.driver_name || '').trim();
    if (driverId || driverName) {
        const label = driverName ? `${driverName}${driverId ? ` (${driverId})` : ''}` : `Sofer ${driverId}`;
        return { key: `driver:${driverId || driverName}`, label, role: 'Driver' };
    }

    const fromId = String(data?.from_user_id || '').trim().toUpperCase();
    const fromRole = String(data?.from_role || '').trim();
    if (fromId || fromRole) {
        const roleLabel = fromRole || 'User';
        const label = fromId ? `${roleLabel} ${fromId}` : roleLabel;
        return { key: `from:${fromRole}:${fromId}`, label, role: fromRole || 'Unknown' };
    }

    const requestedBy = String(data?.requested_by || '').trim().toUpperCase();
    if (requestedBy) {
        return { key: `requester:${requestedBy}`, label: `Operator ${requestedBy}`, role: 'Internal' };
    }

    const targetId = String(data?.target_user_id || n?.user_id || '').trim().toUpperCase();
    const targetRole = String(data?.target_role || '').trim();
    const targetName = String(data?.target_name || '').trim();
    if (targetId || targetRole || targetName) {
        const label = targetName || (targetRole ? `${targetRole}${targetId ? ` ${targetId}` : ''}` : targetId);
        return { key: `target:${targetRole}:${targetId}`, label, role: targetRole || 'Unknown' };
    }

    const t = typeInfo(n).key;
    if (t === 'instructions' || t === 'reschedule') {
        return { key: 'recipient:client', label: 'Client / destinatar', role: 'Recipient' };
    }
    if (normalizeRole(currentRole) === ROLE_RECIPIENT) {
        return { key: 'internal:ops', label: 'Echipa companie', role: 'Internal' };
    }
    return { key: 'internal:ops', label: 'Operatiuni interne', role: 'Internal' };
};

const deriveScope = (n, currentRole, counterpartyRole) => {
    const targetRole = String(n?.data?.target_role || '').trim();
    if (isExternalRole(targetRole)) return { key: 'external', label: 'Extern' };
    if (normalizeRole(currentRole) === ROLE_RECIPIENT) return { key: 'external', label: 'Extern' };
    if (isExternalRole(counterpartyRole)) return { key: 'external', label: 'Extern' };
    const t = typeInfo(n).key;
    if (t === 'allocation' || t === 'instructions' || t === 'reschedule') {
        return { key: 'external', label: 'Extern' };
    }
    return { key: 'internal', label: 'Intern' };
};

export default function Notifications() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const currentRole = normalizeRole(user?.role);
    const myId = String(user?.driver_id || '').trim().toUpperCase();
    const canCompanyScope = currentRole !== ROLE_RECIPIENT && currentRole !== ROLE_DRIVER;

    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [scopeFilter, setScopeFilter] = useState('all'); // all | internal | external
    const [typeFilter, setTypeFilter] = useState('all');
    const [withFilter, setWithFilter] = useState('all');
    const [readFilter, setReadFilter] = useState('all'); // all | unread | read
    const [groupBy, setGroupBy] = useState('date'); // date | type | with | scope
    const [periodPreset, setPeriodPreset] = useState('30d');
    const [startDate, setStartDate] = useState(() => resolvePresetRange('30d').startDate);
    const [endDate, setEndDate] = useState(() => resolvePresetRange('30d').endDate);
    const [dataScope, setDataScope] = useState(() => (canCompanyScope ? 'company' : 'mine')); // mine | company

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

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const data = await getNotifications(token, { limit: 300, unread_only: false, scope: dataScope });
            setItems(Array.isArray(data) ? data : []);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load notifications'));
            setItems([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataScope, token]);

    const markRead = async (id) => {
        const ident = id;
        if (!ident) return;
        setBusyId(ident);
        try {
            const updated = await markNotificationRead(token, ident);
            setItems((prev) => (Array.isArray(prev) ? prev.map((n) => (String(n?.id) === String(ident) ? updated : n)) : prev));
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to mark read'));
        } finally {
            setBusyId(null);
        }
    };

    const normalized = useMemo(() => {
        const source = Array.isArray(items) ? items : [];
        return source
            .filter((n) => !isChatNotification(n))
            .map((n) => {
                const commType = typeInfo(n);
                const counterparty = deriveCounterparty(n, currentRole);
                const scope = deriveScope(n, currentRole, counterparty.role);
                const createdAt = n?.created_at || null;
                const createdTs = createdAt ? new Date(createdAt).getTime() : 0;
                const searchBlob = [
                    n?.title,
                    n?.body,
                    n?.awb,
                    counterparty.label,
                    commType.label,
                    scope.label
                ].map((x) => String(x || '')).join(' ').toLowerCase();

                return {
                    raw: n,
                    id: n?.id,
                    unread: !n?.read_at,
                    createdAt,
                    createdTs: Number.isFinite(createdTs) ? createdTs : 0,
                    commType,
                    counterparty,
                    scope,
                    searchBlob,
                };
            })
            .sort((a, b) => b.createdTs - a.createdTs);
    }, [currentRole, items]);

    const hiddenChatCount = useMemo(
        () => (Array.isArray(items) ? items.filter((n) => isChatNotification(n)).length : 0),
        [items]
    );

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

    const typeOptions = useMemo(() => {
        const map = new Map();
        normalized.forEach((x) => {
            const key = String(x?.commType?.key || '').trim();
            if (!key) return;
            if (!map.has(key)) map.set(key, x.commType.label || key);
        });
        return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
    }, [normalized]);

    const filtered = useMemo(() => {
        const needle = normalizeText(search);
        const startTs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
        const endTs = endDate ? new Date(`${endDate}T23:59:59`).getTime() : null;

        return normalized.filter((x) => {
            if (scopeFilter !== 'all' && x.scope.key !== scopeFilter) return false;
            if (typeFilter !== 'all' && x.commType.key !== typeFilter) return false;
            if (withFilter !== 'all' && x.counterparty.key !== withFilter) return false;
            if (readFilter === 'unread' && !x.unread) return false;
            if (readFilter === 'read' && x.unread) return false;
            if (needle && !x.searchBlob.includes(needle)) return false;
            if (Number.isFinite(startTs) && x.createdTs < startTs) return false;
            if (Number.isFinite(endTs) && x.createdTs > endTs) return false;
            return true;
        });
    }, [endDate, normalized, readFilter, scopeFilter, search, startDate, typeFilter, withFilter]);

    const grouped = useMemo(() => {
        const byKey = new Map();
        filtered.forEach((x) => {
            let key = '';
            let label = '';
            if (groupBy === 'type') {
                key = `type:${x.commType.key}`;
                label = x.commType.label;
            } else if (groupBy === 'with') {
                key = `with:${x.counterparty.key}`;
                label = x.counterparty.label;
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
        out.sort((a, b) => b.sortTs - a.sortTs);
        return out;
    }, [filtered, groupBy]);

    const unreadCount = useMemo(
        () => filtered.filter((x) => x.unread).length,
        [filtered]
    );

    const internalCount = useMemo(
        () => filtered.filter((x) => x.scope.key === 'internal').length,
        [filtered]
    );
    const externalCount = useMemo(
        () => filtered.filter((x) => x.scope.key === 'external').length,
        [filtered]
    );

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
                        <Bell size={18} className="text-violet-300" />
                        Notificari
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                        {unreadCount} necitite • {filtered.length} vizibile • {dataScope === 'company' ? 'nivel companie' : 'doar pentru mine'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={loading}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-3 relative z-10">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Vizibile</div>
                        <div className="text-sm font-black text-white mt-1">{filtered.length}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Necitite</div>
                        <div className="text-sm font-black text-white mt-1">{unreadCount}</div>
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

                <div className="glass-light p-3 rounded-2xl border border-amber-500/20 text-[11px] font-bold text-amber-200 flex items-center gap-2">
                    <CalendarDays size={14} className="text-amber-300" />
                    Notificarile de chat sunt afisate doar in ecranul Chat ({hiddenChatCount} ascunse aici).
                </div>

                <div className="glass-strong rounded-3xl border border-white/10 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-400 font-black">
                        <SlidersHorizontal size={13} /> Filtrare & grupare comunicari
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
                                    placeholder="Titlu, AWB, persoana..."
                                    className="w-full bg-transparent text-white text-sm outline-none placeholder:text-slate-600"
                                />
                            </div>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Tip
                            <select
                                value={typeFilter}
                                onChange={(e) => setTypeFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="all">Toate tipurile</option>
                                {typeOptions.map((opt) => (
                                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                                ))}
                            </select>
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
                                <option value="type">Dupa tip</option>
                                <option value="with">Dupa persoana</option>
                                <option value="scope">Dupa comunicare</option>
                            </select>
                        </label>

                        {canCompanyScope ? (
                            <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                                Vizualizare
                                <select
                                    value={dataScope}
                                    onChange={(e) => setDataScope(e.target.value)}
                                    className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                                >
                                    <option value="company">Companie</option>
                                    <option value="mine">Doar pentru mine</option>
                                </select>
                            </label>
                        ) : null}
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

                {loading ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 flex items-center gap-3 text-slate-300">
                        <Loader2 className="animate-spin" size={18} />
                        <span className="text-sm font-bold">Loading...</span>
                    </div>
                ) : null}

                {!loading && grouped.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <Bell className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">Nu exista notificari pentru filtrele selectate</p>
                        <p className="text-sm mt-2 text-slate-500">Schimba perioada, tipul sau persoana.</p>
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
                                    {section.items.length} notificari
                                </span>
                            </div>
                            <div className="space-y-2">
                                {section.items.map((x) => {
                                    const n = x.raw;
                                    const unread = x.unread;
                                    const notifUserId = String(n?.user_id || '').trim().toUpperCase();
                                    const canMarkRead = unread && (dataScope !== 'company' || notifUserId === myId);
                                    
                                    const routePlanId = n?.data?.route_plan_id ? Number(n.data.route_plan_id) : null;
                                    const handleCardClick = (e) => {
                                        if (e.target.closest('button') || e.target.closest('a')) return;
                                        if (routePlanId) {
                                            navigate(`/routes?planId=${routePlanId}`);
                                        }
                                    };

                                    return (
                                        <div
                                            key={n.id}
                                            onClick={handleCardClick}
                                            className={`glass-strong p-4 rounded-3xl border transition-all ${routePlanId ? 'cursor-pointer hover:bg-white/5 active:scale-[0.99]' : ''} ${unread ? 'border-emerald-500/30' : 'border-white/10 opacity-90'}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="text-sm font-black text-white truncate">{n.title || 'Notificare'}</p>
                                                        <span className={`px-2 py-1 rounded-full border text-[9px] font-black uppercase tracking-wider ${x.scope.key === 'external'
                                                            ? 'bg-amber-500/15 border-amber-500/30 text-amber-200'
                                                            : 'bg-sky-500/15 border-sky-500/30 text-sky-200'
                                                            }`}>
                                                            {x.scope.label}
                                                        </span>
                                                        <span className="px-2 py-1 rounded-full border border-white/15 bg-white/5 text-[9px] font-black uppercase tracking-wider text-slate-300">
                                                            {x.commType.label}
                                                        </span>
                                                        {unread ? (
                                                            <span className="px-2 py-1 rounded-full border border-emerald-500/25 bg-emerald-500/15 text-[9px] font-black uppercase tracking-wider text-emerald-200">
                                                                Necitita
                                                            </span>
                                                        ) : null}
                                                    </div>

                                                    <p className="text-xs text-slate-300 font-medium mt-2 break-words">
                                                        {n.body || ''}
                                                    </p>

                                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2 flex flex-wrap items-center gap-1.5">
                                                        <span>{fmtDateTime(n.created_at)}</span>
                                                        {n.awb ? (
                                                            <>
                                                                <span>•</span>
                                                                <AwbLink
                                                                    awb={n.awb}
                                                                    className="cursor-pointer hover:text-emerald-300"
                                                                    title="Deschide detalii AWB"
                                                                >
                                                                    {String(n.awb).toUpperCase()}
                                                                </AwbLink>
                                                            </>
                                                        ) : null}
                                                        {x.counterparty?.label ? <span>• Cu: {x.counterparty.label}</span> : null}
                                                        {dataScope === 'company' ? <span>• Pentru: {String(n?.data?.target_name || n?.user_id || '--')}</span> : null}
                                                    </div>
                                                </div>
                                                {canMarkRead ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => markRead(n.id)}
                                                        disabled={String(busyId) === String(n.id)}
                                                        className={`p-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all ${String(busyId) === String(n.id) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                        title="Marcheaza ca citita"
                                                    >
                                                        <Check size={18} />
                                                    </button>
                                                ) : null}
                                            </div>
                                        </div>
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
