import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, Loader2, Plus, RefreshCw, Save, Search, Store, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../auth/rbac';
import { PERM_USERS_WRITE } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
    createStore as apiCreateStore,
    createWarehouse as apiCreateWarehouse,
    listStores as apiListStores,
    listWarehouses as apiListWarehouses,
    updateStore as apiUpdateStore,
    updateWarehouse as apiUpdateWarehouse,
} from '../services/api';
import { toUiError } from '../services/uiErrors';

const TAB_WAREHOUSES = 'warehouses';
const TAB_STORES = 'stores';

const emptyWarehouseForm = () => ({
    code: '',
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    active: true,
});

const emptyStoreForm = () => ({
    code: '',
    name: '',
    warehouse_id: '',
    address: '',
    latitude: '',
    longitude: '',
    active: true,
});

const toOptionalFloat = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return n;
};

const toOptionalInt = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.trunc(n);
};

const Modal = ({ open, title, children, onClose }) => (
    <AnimatePresence>
        {open ? (
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[65] flex items-end justify-center bg-black/70 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 24, opacity: 0 }}
                    className="w-full max-w-lg glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{title}</p>
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-2 rounded-2xl glass-light border border-white/10 text-slate-300 hover:text-white active:scale-95 transition-all"
                            aria-label="Close"
                        >
                            <X size={18} />
                        </button>
                    </div>
                    {children}
                </motion.div>
            </motion.div>
        ) : null}
    </AnimatePresence>
);

export default function Warehouses() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);
    const token = user?.token || localStorage.getItem('token');
    const canWrite = useMemo(() => hasPermission(user, PERM_USERS_WRITE), [user]);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const [error, setError] = useState('');
    const [tab, setTab] = useState(TAB_WAREHOUSES);
    const [search, setSearch] = useState('');

    const [warehouses, setWarehouses] = useState([]);
    const [stores, setStores] = useState([]);

    const [createOpen, setCreateOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [editRow, setEditRow] = useState(null);

    const [warehouseForm, setWarehouseForm] = useState(emptyWarehouseForm);
    const [storeForm, setStoreForm] = useState(emptyStoreForm);
    const [warehouseEditForm, setWarehouseEditForm] = useState(emptyWarehouseForm);
    const [storeEditForm, setStoreEditForm] = useState(emptyStoreForm);

    const refresh = async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        try {
            const [whRows, storeRows] = await Promise.all([
                apiListWarehouses(token),
                apiListStores(token),
            ]);
            setWarehouses(Array.isArray(whRows) ? whRows : []);
            setStores(Array.isArray(storeRows) ? storeRows : []);
        } catch (e) {
            setError(toUiError(e, {
                lang,
                fallbackRo: 'Nu am putut incarca depozitele si magazinele.',
                fallbackEn: 'Failed to load warehouses and stores.',
            }));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const warehouseById = useMemo(() => {
        const map = new Map();
        (Array.isArray(warehouses) ? warehouses : []).forEach((w) => {
            const id = Number(w?.id || 0);
            if (!Number.isFinite(id) || id <= 0) return;
            map.set(id, w);
        });
        return map;
    }, [warehouses]);

    const filteredWarehouses = useMemo(() => {
        const needle = String(search || '').trim().toLowerCase();
        const list = Array.isArray(warehouses) ? warehouses : [];
        if (!needle) return list;
        return list.filter((w) => (
            String(w?.code || '').toLowerCase().includes(needle)
            || String(w?.name || '').toLowerCase().includes(needle)
            || String(w?.address || '').toLowerCase().includes(needle)
        ));
    }, [warehouses, search]);

    const filteredStores = useMemo(() => {
        const needle = String(search || '').trim().toLowerCase();
        const list = Array.isArray(stores) ? stores : [];
        if (!needle) return list;
        return list.filter((s) => {
            const warehouseName = String(
                s?.warehouse_name || warehouseById.get(Number(s?.warehouse_id || 0))?.name || ''
            ).toLowerCase();
            return (
                String(s?.code || '').toLowerCase().includes(needle)
                || String(s?.name || '').toLowerCase().includes(needle)
                || String(s?.address || '').toLowerCase().includes(needle)
                || warehouseName.includes(needle)
            );
        });
    }, [stores, search, warehouseById]);

    const openCreateModal = () => {
        setError('');
        setMsg('');
        setWarehouseForm(emptyWarehouseForm());
        setStoreForm(emptyStoreForm());
        setCreateOpen(true);
    };

    const openEditWarehouse = (row) => {
        setEditRow({ type: TAB_WAREHOUSES, row });
        setWarehouseEditForm({
            code: String(row?.code || ''),
            name: String(row?.name || ''),
            address: String(row?.address || ''),
            latitude: row?.latitude != null ? String(row.latitude) : '',
            longitude: row?.longitude != null ? String(row.longitude) : '',
            active: row?.active !== false,
        });
        setEditOpen(true);
    };

    const openEditStore = (row) => {
        setEditRow({ type: TAB_STORES, row });
        setStoreEditForm({
            code: String(row?.code || ''),
            name: String(row?.name || ''),
            warehouse_id: row?.warehouse_id != null ? String(row.warehouse_id) : '',
            address: String(row?.address || ''),
            latitude: row?.latitude != null ? String(row.latitude) : '',
            longitude: row?.longitude != null ? String(row.longitude) : '',
            active: row?.active !== false,
        });
        setEditOpen(true);
    };

    const submitCreateWarehouse = async () => {
        if (!token) return;
        const payload = {
            code: String(warehouseForm.code || '').trim().toUpperCase(),
            name: String(warehouseForm.name || '').trim(),
            address: String(warehouseForm.address || '').trim() || undefined,
            latitude: toOptionalFloat(warehouseForm.latitude),
            longitude: toOptionalFloat(warehouseForm.longitude),
            active: Boolean(warehouseForm.active),
        };
        if (!payload.code || !payload.name) {
            setError(l('Code and name are required.', 'Codul si numele sunt obligatorii.'));
            return;
        }
        setBusy(true);
        setError('');
        setMsg('');
        try {
            await apiCreateWarehouse(token, payload);
            setMsg(l('Warehouse created.', 'Depozit creat.'));
            setCreateOpen(false);
            await refresh();
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut crea depozitul.', fallbackEn: 'Failed to create warehouse.' }));
        } finally {
            setBusy(false);
        }
    };

    const submitCreateStore = async () => {
        if (!token) return;
        const payload = {
            code: String(storeForm.code || '').trim().toUpperCase(),
            name: String(storeForm.name || '').trim(),
            warehouse_id: toOptionalInt(storeForm.warehouse_id),
            address: String(storeForm.address || '').trim() || undefined,
            latitude: toOptionalFloat(storeForm.latitude),
            longitude: toOptionalFloat(storeForm.longitude),
            active: Boolean(storeForm.active),
        };
        if (!payload.code || !payload.name) {
            setError(l('Code and name are required.', 'Codul si numele sunt obligatorii.'));
            return;
        }
        setBusy(true);
        setError('');
        setMsg('');
        try {
            await apiCreateStore(token, payload);
            setMsg(l('Store created.', 'Magazin creat.'));
            setCreateOpen(false);
            await refresh();
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut crea magazinul.', fallbackEn: 'Failed to create store.' }));
        } finally {
            setBusy(false);
        }
    };

    const submitEditWarehouse = async () => {
        if (!token || !editRow?.row?.id) return;
        const payload = {
            code: String(warehouseEditForm.code || '').trim().toUpperCase(),
            name: String(warehouseEditForm.name || '').trim(),
            address: String(warehouseEditForm.address || '').trim() || null,
            latitude: toOptionalFloat(warehouseEditForm.latitude),
            longitude: toOptionalFloat(warehouseEditForm.longitude),
            active: Boolean(warehouseEditForm.active),
        };
        if (!payload.code || !payload.name) {
            setError(l('Code and name are required.', 'Codul si numele sunt obligatorii.'));
            return;
        }
        setBusy(true);
        setError('');
        setMsg('');
        try {
            await apiUpdateWarehouse(token, editRow.row.id, payload);
            setMsg(l('Warehouse updated.', 'Depozit actualizat.'));
            setEditOpen(false);
            setEditRow(null);
            await refresh();
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut actualiza depozitul.', fallbackEn: 'Failed to update warehouse.' }));
        } finally {
            setBusy(false);
        }
    };

    const submitEditStore = async () => {
        if (!token || !editRow?.row?.id) return;
        const payload = {
            code: String(storeEditForm.code || '').trim().toUpperCase(),
            name: String(storeEditForm.name || '').trim(),
            warehouse_id: toOptionalInt(storeEditForm.warehouse_id),
            address: String(storeEditForm.address || '').trim() || null,
            latitude: toOptionalFloat(storeEditForm.latitude),
            longitude: toOptionalFloat(storeEditForm.longitude),
            active: Boolean(storeEditForm.active),
        };
        if (!payload.code || !payload.name) {
            setError(l('Code and name are required.', 'Codul si numele sunt obligatorii.'));
            return;
        }
        setBusy(true);
        setError('');
        setMsg('');
        try {
            await apiUpdateStore(token, editRow.row.id, payload);
            setMsg(l('Store updated.', 'Magazin actualizat.'));
            setEditOpen(false);
            setEditRow(null);
            await refresh();
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut actualiza magazinul.', fallbackEn: 'Failed to update store.' }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-16 right-0 w-80 h-80 bg-blue-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-cyan-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button
                        onClick={() => navigate(-1)}
                        className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10"
                    >
                        <ArrowLeft />
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="font-black text-xl text-gradient tracking-tight truncate">
                            {l('Warehouses & Stores', 'Depozite & Magazine')}
                        </h1>
                        <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wide mt-1 truncate">
                            {l('Multi-warehouse configuration', 'Configurare multi-depozit')}
                        </p>
                    </div>

                    <button
                        onClick={refresh}
                        className={`p-2 rounded-xl glass-light hover:bg-violet-500/20 text-violet-400 transition-all border border-white/10 ${loading ? 'animate-spin' : ''}`}
                        title={l('Refresh', 'Refresh')}
                    >
                        <RefreshCw size={20} />
                    </button>

                    <button
                        onClick={openCreateModal}
                        disabled={!canWrite}
                        className={`p-2 rounded-xl glass-light border border-white/10 transition-all ${canWrite ? 'text-emerald-300 hover:bg-emerald-500/10 active:scale-95' : 'text-slate-600 cursor-not-allowed opacity-60'}`}
                    >
                        <Plus size={20} />
                    </button>
                </div>

                <div className="px-4 pb-2">
                    <div className="relative group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition-colors z-10" size={18} />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={l('Search code, name, address...', 'Cauta cod, nume, adresa...')}
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-violet-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                        />
                    </div>
                </div>

                <div className="px-4 pb-3 flex gap-2">
                    <button
                        type="button"
                        onClick={() => setTab(TAB_WAREHOUSES)}
                        className={`px-3 py-2 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-all ${tab === TAB_WAREHOUSES ? 'bg-blue-500/20 border-blue-400/40 text-blue-100' : 'bg-slate-900/30 border-white/10 text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'}`}
                    >
                        {l('Warehouses', 'Depozite')} ({(Array.isArray(warehouses) ? warehouses : []).length})
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab(TAB_STORES)}
                        className={`px-3 py-2 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-all ${tab === TAB_STORES ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-100' : 'bg-slate-900/30 border-white/10 text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'}`}
                    >
                        {l('Stores', 'Magazine')} ({(Array.isArray(stores) ? stores : []).length})
                    </button>
                </div>
            </div>

            <div className="flex-1 p-4 pb-32 relative z-10 space-y-3">
                {error ? (
                    <div className="glass-strong rounded-2xl border border-rose-500/20 p-4 text-rose-200 text-xs font-bold">
                        {error}
                    </div>
                ) : null}
                {msg ? (
                    <div className="glass-strong rounded-2xl border border-emerald-500/20 p-4 text-emerald-200 text-xs font-bold flex items-center gap-2">
                        <CheckCircle2 size={16} />
                        <span>{msg}</span>
                    </div>
                ) : null}

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                        <Loader2 className="animate-spin text-violet-400" size={48} />
                        <p className="mt-5 font-bold text-xs uppercase tracking-widest text-slate-500">
                            {l('Loading...', 'Se incarca...')}
                        </p>
                    </div>
                ) : tab === TAB_WAREHOUSES ? (
                    (filteredWarehouses.length === 0 ? (
                        <div className="text-center py-16 text-slate-400">
                            <Building2 size={36} className="mx-auto text-slate-500" />
                            <p className="mt-4 font-bold">{l('No warehouses found.', 'Nu exista depozite gasite.')}</p>
                        </div>
                    ) : (
                        filteredWarehouses.map((w) => (
                            <div key={String(w?.id)} className="glass-strong p-4 rounded-3xl border border-white/10 hover:border-blue-500/25 transition-all">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-base font-black text-white truncate">{w?.name || '-'}</p>
                                        <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                            {String(w?.code || '-')}
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-2 truncate">
                                            {String(w?.address || l('Address not set', 'Adresa nesetata'))}
                                        </p>
                                        <p className="text-[11px] text-slate-500 mt-1">
                                            {w?.latitude != null && w?.longitude != null
                                                ? `Lat ${w.latitude}, Lon ${w.longitude}`
                                                : l('Coordinates not set', 'Coordonate nesetate')}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-2">
                                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${w?.active !== false ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' : 'bg-rose-500/15 text-rose-200 border-rose-500/20'}`}>
                                            {w?.active !== false ? l('Active', 'Activ') : l('Inactive', 'Inactiv')}
                                        </span>
                                        {canWrite ? (
                                            <button
                                                type="button"
                                                onClick={() => openEditWarehouse(w)}
                                                className="px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-[11px] font-black uppercase tracking-widest hover:bg-white/10 active:scale-95 transition-all"
                                            >
                                                {l('Edit', 'Editeaza')}
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        ))
                    ))
                ) : (
                    (filteredStores.length === 0 ? (
                        <div className="text-center py-16 text-slate-400">
                            <Store size={36} className="mx-auto text-slate-500" />
                            <p className="mt-4 font-bold">{l('No stores found.', 'Nu exista magazine gasite.')}</p>
                        </div>
                    ) : (
                        filteredStores.map((s) => (
                            <div key={String(s?.id)} className="glass-strong p-4 rounded-3xl border border-white/10 hover:border-cyan-500/25 transition-all">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-base font-black text-white truncate">{s?.name || '-'}</p>
                                        <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                            {String(s?.code || '-')}
                                        </p>
                                        <p className="text-[11px] text-cyan-300 font-bold mt-2 truncate">
                                            {l('Warehouse', 'Depozit')}: {String(s?.warehouse_name || warehouseById.get(Number(s?.warehouse_id || 0))?.name || '-')}
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-1 truncate">
                                            {String(s?.address || l('Address not set', 'Adresa nesetata'))}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-2">
                                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${s?.active !== false ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' : 'bg-rose-500/15 text-rose-200 border-rose-500/20'}`}>
                                            {s?.active !== false ? l('Active', 'Activ') : l('Inactive', 'Inactiv')}
                                        </span>
                                        {canWrite ? (
                                            <button
                                                type="button"
                                                onClick={() => openEditStore(s)}
                                                className="px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-[11px] font-black uppercase tracking-widest hover:bg-white/10 active:scale-95 transition-all"
                                            >
                                                {l('Edit', 'Editeaza')}
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        ))
                    ))
                )}
            </div>

            <Modal
                open={createOpen}
                title={tab === TAB_WAREHOUSES ? l('Create Warehouse', 'Creeaza Depozit') : l('Create Store', 'Creeaza Magazin')}
                onClose={() => { if (!busy) setCreateOpen(false); }}
            >
                {tab === TAB_WAREHOUSES ? (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <input
                                value={warehouseForm.code}
                                onChange={(e) => setWarehouseForm((p) => ({ ...p, code: e.target.value }))}
                                placeholder="Code"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                            <input
                                value={warehouseForm.name}
                                onChange={(e) => setWarehouseForm((p) => ({ ...p, name: e.target.value }))}
                                placeholder={l('Name', 'Nume')}
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                        </div>
                        <input
                            value={warehouseForm.address}
                            onChange={(e) => setWarehouseForm((p) => ({ ...p, address: e.target.value }))}
                            placeholder={l('Address', 'Adresa')}
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                        />
                        <div className="grid grid-cols-2 gap-3">
                            <input
                                value={warehouseForm.latitude}
                                onChange={(e) => setWarehouseForm((p) => ({ ...p, latitude: e.target.value }))}
                                placeholder="Latitude"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                            <input
                                value={warehouseForm.longitude}
                                onChange={(e) => setWarehouseForm((p) => ({ ...p, longitude: e.target.value }))}
                                placeholder="Longitude"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input
                                type="checkbox"
                                checked={Boolean(warehouseForm.active)}
                                onChange={(e) => setWarehouseForm((p) => ({ ...p, active: e.target.checked }))}
                            />
                            <span>{l('Active', 'Activ')}</span>
                        </label>
                        <button
                            type="button"
                            onClick={submitCreateWarehouse}
                            disabled={!canWrite || busy}
                            className={`w-full py-3 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 ${(!canWrite || busy) ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70' : 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white'}`}
                        >
                            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            {l('Save', 'Salveaza')}
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <input
                                value={storeForm.code}
                                onChange={(e) => setStoreForm((p) => ({ ...p, code: e.target.value }))}
                                placeholder="Code"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                            <input
                                value={storeForm.name}
                                onChange={(e) => setStoreForm((p) => ({ ...p, name: e.target.value }))}
                                placeholder={l('Name', 'Nume')}
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                        </div>
                        <select
                            value={storeForm.warehouse_id}
                            onChange={(e) => setStoreForm((p) => ({ ...p, warehouse_id: e.target.value }))}
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                        >
                            <option value="">{l('Warehouse (optional)', 'Depozit (optional)')}</option>
                            {(Array.isArray(warehouses) ? warehouses : []).map((w) => (
                                <option key={String(w?.id)} value={String(w?.id || '')}>
                                    {String(w?.name || w?.code || `WH-${w?.id}`)}
                                </option>
                            ))}
                        </select>
                        <input
                            value={storeForm.address}
                            onChange={(e) => setStoreForm((p) => ({ ...p, address: e.target.value }))}
                            placeholder={l('Address', 'Adresa')}
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                        />
                        <div className="grid grid-cols-2 gap-3">
                            <input
                                value={storeForm.latitude}
                                onChange={(e) => setStoreForm((p) => ({ ...p, latitude: e.target.value }))}
                                placeholder="Latitude"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                            <input
                                value={storeForm.longitude}
                                onChange={(e) => setStoreForm((p) => ({ ...p, longitude: e.target.value }))}
                                placeholder="Longitude"
                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input
                                type="checkbox"
                                checked={Boolean(storeForm.active)}
                                onChange={(e) => setStoreForm((p) => ({ ...p, active: e.target.checked }))}
                            />
                            <span>{l('Active', 'Activ')}</span>
                        </label>
                        <button
                            type="button"
                            onClick={submitCreateStore}
                            disabled={!canWrite || busy}
                            className={`w-full py-3 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 ${(!canWrite || busy) ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70' : 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white'}`}
                        >
                            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            {l('Save', 'Salveaza')}
                        </button>
                    </div>
                )}
            </Modal>

            <Modal
                open={editOpen}
                title={editRow?.type === TAB_WAREHOUSES ? l('Edit Warehouse', 'Editeaza Depozit') : l('Edit Store', 'Editeaza Magazin')}
                onClose={() => { if (!busy) setEditOpen(false); }}
            >
                {editRow?.type === TAB_WAREHOUSES ? (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <input value={warehouseEditForm.code} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, code: e.target.value }))} placeholder="Code" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                            <input value={warehouseEditForm.name} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, name: e.target.value }))} placeholder={l('Name', 'Nume')} className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        </div>
                        <input value={warehouseEditForm.address} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, address: e.target.value }))} placeholder={l('Address', 'Adresa')} className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        <div className="grid grid-cols-2 gap-3">
                            <input value={warehouseEditForm.latitude} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, latitude: e.target.value }))} placeholder="Latitude" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                            <input value={warehouseEditForm.longitude} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, longitude: e.target.value }))} placeholder="Longitude" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input type="checkbox" checked={Boolean(warehouseEditForm.active)} onChange={(e) => setWarehouseEditForm((p) => ({ ...p, active: e.target.checked }))} />
                            <span>{l('Active', 'Activ')}</span>
                        </label>
                        <button type="button" onClick={submitEditWarehouse} disabled={!canWrite || busy} className={`w-full py-3 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 ${(!canWrite || busy) ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70' : 'bg-gradient-to-r from-violet-600 to-purple-600 text-white'}`}>
                            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            {l('Save changes', 'Salveaza modificarile')}
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <input value={storeEditForm.code} onChange={(e) => setStoreEditForm((p) => ({ ...p, code: e.target.value }))} placeholder="Code" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                            <input value={storeEditForm.name} onChange={(e) => setStoreEditForm((p) => ({ ...p, name: e.target.value }))} placeholder={l('Name', 'Nume')} className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        </div>
                        <select value={storeEditForm.warehouse_id} onChange={(e) => setStoreEditForm((p) => ({ ...p, warehouse_id: e.target.value }))} className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white">
                            <option value="">{l('Warehouse (optional)', 'Depozit (optional)')}</option>
                            {(Array.isArray(warehouses) ? warehouses : []).map((w) => (
                                <option key={String(w?.id)} value={String(w?.id || '')}>
                                    {String(w?.name || w?.code || `WH-${w?.id}`)}
                                </option>
                            ))}
                        </select>
                        <input value={storeEditForm.address} onChange={(e) => setStoreEditForm((p) => ({ ...p, address: e.target.value }))} placeholder={l('Address', 'Adresa')} className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        <div className="grid grid-cols-2 gap-3">
                            <input value={storeEditForm.latitude} onChange={(e) => setStoreEditForm((p) => ({ ...p, latitude: e.target.value }))} placeholder="Latitude" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                            <input value={storeEditForm.longitude} onChange={(e) => setStoreEditForm((p) => ({ ...p, longitude: e.target.value }))} placeholder="Longitude" className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white" />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input type="checkbox" checked={Boolean(storeEditForm.active)} onChange={(e) => setStoreEditForm((p) => ({ ...p, active: e.target.checked }))} />
                            <span>{l('Active', 'Activ')}</span>
                        </label>
                        <button type="button" onClick={submitEditStore} disabled={!canWrite || busy} className={`w-full py-3 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 ${(!canWrite || busy) ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70' : 'bg-gradient-to-r from-violet-600 to-purple-600 text-white'}`}>
                            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            {l('Save changes', 'Salveaza modificarile')}
                        </button>
                    </div>
                )}
            </Modal>
        </motion.div>
    );
}
