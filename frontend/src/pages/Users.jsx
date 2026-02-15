import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, MapPin, Plus, RefreshCw, Save, Search, ShieldAlert, UserCog, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { hasPermission } from '../auth/rbac';
import { PERM_USERS_WRITE } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { createTrackingRequest, createUser, getRoles, listUsers, updateUser } from '../services/api';

const DEFAULT_ROLE = 'Driver';

const emptyCreate = () => ({
    driver_id: '',
    name: '',
    username: '',
    password: '',
    role: DEFAULT_ROLE,
    active: true,
    truck_plate: '',
    phone_number: '',
    helper_name: '',
});

const normalizeRole = (value) => String(value || '').trim() || DEFAULT_ROLE;

const Modal = ({ open, title, children, onClose }) => (
    <AnimatePresence>
        {open && (
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 24, opacity: 0 }}
                    className="w-full max-w-md glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{title}</p>
                        </div>
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
        )}
    </AnimatePresence>
);

export default function Users() {
    const navigate = useNavigate();
    const location = useLocation();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const canWrite = useMemo(() => hasPermission(user, PERM_USERS_WRITE), [user]);
    const canRequestTracking = useMemo(() => (
        ['Admin', 'Manager', 'Dispatcher', 'Support'].includes(String(user?.role || '').trim())
    ), [user?.role]);
    const queryHandledRef = useRef(false);

    const returnTo = useMemo(() => {
        const params = new URLSearchParams(location.search);
        const raw = String(params.get('returnTo') || '').trim();
        return raw.startsWith('/') ? raw : '';
    }, [location.search]);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');
    const [trackBusyId, setTrackBusyId] = useState('');

    const [roles, setRoles] = useState([]);
    const [users, setUsers] = useState([]);
    const [search, setSearch] = useState('');

    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState(emptyCreate);

    const [editOpen, setEditOpen] = useState(false);
    const [editUser, setEditUser] = useState(null);
    const [editForm, setEditForm] = useState({ name: '', username: '', password: '', role: DEFAULT_ROLE, active: true, truck_plate: '', phone_number: '', helper_name: '' });

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const [rolesRes, usersRes] = await Promise.all([
                getRoles(token).catch(() => null),
                listUsers(token),
            ]);
            const roleList = Array.isArray(rolesRes) ? rolesRes : [];
            setRoles(roleList);
            setUsers(Array.isArray(usersRes) ? usersRes : []);
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to load users';
            setError(String(detail));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (queryHandledRef.current) return;

        const params = new URLSearchParams(location.search);
        const wantCreate = ['1', 'true', 'yes', 'on'].includes(String(params.get('create') || '').toLowerCase());
        if (!wantCreate) {
            queryHandledRef.current = true;
            return;
        }

        // Only admins can create; ignore the query param otherwise.
        if (!canWrite) {
            queryHandledRef.current = true;
            return;
        }

        const roleParam = String(params.get('role') || '').trim();
        setCreateForm((prev) => ({
            ...emptyCreate(),
            role: roleParam || prev.role || DEFAULT_ROLE,
        }));
        setCreateOpen(true);
        queryHandledRef.current = true;
    }, [location.search, canWrite]);

    const roleOptions = useMemo(() => {
        if (roles.length > 0) {
            return roles.map((r) => r?.role).filter(Boolean);
        }
        return [DEFAULT_ROLE, 'Admin', 'Manager', 'Dispatcher', 'Warehouse', 'Support', 'Finance', 'Viewer', 'Recipient'];
    }, [roles]);

    const filtered = useMemo(() => {
        const needle = String(search || '').trim().toLowerCase();
        const list = Array.isArray(users) ? users : [];
        if (!needle) return list;
        return list.filter((u) => (
            String(u?.driver_id || '').toLowerCase().includes(needle)
            || String(u?.username || '').toLowerCase().includes(needle)
            || String(u?.name || '').toLowerCase().includes(needle)
            || String(u?.role || '').toLowerCase().includes(needle)
        ));
    }, [users, search]);

    const openEdit = (u) => {
        if (!u) return;
        setEditUser(u);
        setEditForm({
            name: String(u?.name || ''),
            username: String(u?.username || ''),
            password: '',
            role: normalizeRole(u?.role),
            active: Boolean(u?.active),
            truck_plate: String(u?.truck_plate || ''),
            phone_number: String(u?.phone_number || ''),
            helper_name: String(u?.helper_name || ''),
        });
        setEditOpen(true);
    };

    const submitCreate = async () => {
        setBusy(true);
        setError('');
        setMsg('');
        try {
            const payload = {
                driver_id: String(createForm.driver_id || '').trim(),
                name: String(createForm.name || '').trim(),
                username: String(createForm.username || '').trim(),
                password: String(createForm.password || ''),
                role: normalizeRole(createForm.role),
                active: Boolean(createForm.active),
                truck_plate: String(createForm.truck_plate || '').trim(),
                phone_number: String(createForm.phone_number || '').trim(),
                helper_name: String(createForm.helper_name || '').trim(),
            };

            if (!payload.driver_id || !payload.username || !payload.name || !payload.password) {
                setError('driver_id, name, username and password are required.');
                return;
            }

            await createUser(token, payload);
            setMsg('Account created.');
            setCreateOpen(false);
            setCreateForm(emptyCreate());
            await refresh();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to create user';
            setError(String(detail));
        } finally {
            setBusy(false);
        }
    };

    const submitEdit = async () => {
        if (!editUser?.driver_id) return;
        setBusy(true);
        setError('');
        setMsg('');
        try {
            const patch = {
                name: String(editForm.name || '').trim(),
                username: String(editForm.username || '').trim(),
                role: normalizeRole(editForm.role),
                active: Boolean(editForm.active),
                truck_plate: String(editForm.truck_plate || '').trim(),
                phone_number: String(editForm.phone_number || '').trim(),
                helper_name: String(editForm.helper_name || '').trim(),
            };
            const password = String(editForm.password || '').trim();
            if (password) patch.password = password;

            await updateUser(token, editUser.driver_id, patch);
            setMsg('Account updated.');
            setEditOpen(false);
            setEditUser(null);
            await refresh();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to update user';
            setError(String(detail));
        } finally {
            setBusy(false);
        }
    };

    const requestTracking = async (u) => {
        if (!canRequestTracking) return;
        const did = String(u?.driver_id || '').trim().toUpperCase();
        if (!did || !token) return;

        setTrackBusyId(did);
        setError('');
        setMsg('');
        try {
            const res = await createTrackingRequest(token, { driver_id: did, duration_sec: 1800 });
            const id = res?.id;
            if (id) {
                navigate(`/tracking/${encodeURIComponent(String(id))}`);
                return;
            }
            setMsg('Tracking request created.');
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to request tracking';
            setError(String(detail));
        } finally {
            setTrackBusyId('');
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-10 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button
                        onClick={() => (returnTo ? navigate(returnTo) : navigate(-1))}
                        className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10"
                        aria-label="Back"
                    >
                        <ArrowLeft />
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="font-black text-xl text-gradient tracking-tight truncate">Users</h1>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1 truncate">
                            {canWrite ? 'Create and manage accounts' : 'Read-only access'}
                        </p>
                    </div>

                    <button
                        onClick={refresh}
                        className={`p-2 rounded-xl glass-light hover:bg-violet-500/20 text-violet-400 transition-all border border-white/10 ${loading ? 'animate-spin' : ''}`}
                        title="Refresh"
                    >
                        <RefreshCw size={20} />
                    </button>

                    <button
                        onClick={() => { setCreateOpen(true); setCreateForm(emptyCreate()); }}
                        disabled={!canWrite}
                        className={`p-2 rounded-xl glass-light border border-white/10 transition-all ${canWrite ? 'text-emerald-300 hover:bg-emerald-500/10 active:scale-95' : 'text-slate-600 cursor-not-allowed opacity-60'}`}
                        title={canWrite ? 'Create account' : 'Not allowed'}
                        aria-label="Create account"
                    >
                        <Plus size={20} />
                    </button>
                </div>

                <div className="px-4 pb-3">
                    <div className="relative group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition-colors z-10" size={18} />
                        <input
                            type="text"
                            placeholder="Search driver_id, username, name, role..."
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-violet-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div className="flex-1 p-4 pb-32 relative z-10 space-y-3">
                {error && (
                    <div className="glass-strong rounded-2xl border border-rose-500/20 p-4 text-rose-200 text-xs font-bold flex items-center gap-3">
                        <ShieldAlert size={16} className="text-rose-300" />
                        <span className="flex-1">{error}</span>
                    </div>
                )}

                {msg && (
                    <div className="glass-strong rounded-2xl border border-emerald-500/20 p-4 text-emerald-200 text-xs font-bold flex items-center gap-3">
                        <CheckCircle2 size={16} className="text-emerald-300" />
                        <span className="flex-1">{msg}</span>
                    </div>
                )}

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                        <div className="relative">
                            <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                            <Loader2 className="animate-spin relative z-10 text-violet-400" size={48} />
                        </div>
                        <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">Loading users...</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-20 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <UserCog className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No users</p>
                        <p className="text-sm mt-2 text-slate-500">Try changing your search</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filtered.map((u) => (
                            <div
                                key={u?.driver_id || u?.id}
                                className="glass-strong p-5 rounded-3xl border border-white/10 hover:border-violet-500/25 transition-all"
                            >
                                <div className="flex items-start gap-4">
                                    <div className="w-12 h-12 rounded-2xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
                                        <UserCog size={20} className="text-violet-300" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-sm font-black text-white truncate">{u?.name || u?.username || u?.driver_id}</p>
                                            <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${u?.active ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' : 'bg-rose-500/15 text-rose-200 border-rose-500/20'}`}>
                                                {u?.active ? 'Active' : 'Inactive'}
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1 truncate">
                                            <span className="font-mono text-slate-300">{u?.driver_id}</span>
                                            {' • '}
                                            <span className="font-mono">{u?.username}</span>
                                            {' • '}
                                            {u?.role || '—'}
                                        </p>
                                        {u?.last_login && (
                                            <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                Last login: {new Date(u.last_login).toLocaleString()}
                                            </p>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2">
                                        {canRequestTracking && String(u?.role || '') !== 'Recipient' ? (
                                            <button
                                                type="button"
                                                onClick={() => requestTracking(u)}
                                                disabled={String(trackBusyId) === String(String(u?.driver_id || '').trim().toUpperCase())}
                                                className={`px-3 py-2 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${String(trackBusyId) === String(String(u?.driver_id || '').trim().toUpperCase())
                                                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200 opacity-70 cursor-not-allowed'
                                                    : 'bg-emerald-500/15 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95'
                                                    }`}
                                                title="Request live location"
                                            >
                                                {String(trackBusyId) === String(String(u?.driver_id || '').trim().toUpperCase())
                                                    ? <Loader2 size={14} className="animate-spin" />
                                                    : <MapPin size={14} />
                                                }
                                                Track
                                            </button>
                                        ) : null}

                                        <button
                                            type="button"
                                            onClick={() => openEdit(u)}
                                            disabled={!canWrite}
                                            className={`px-4 py-2 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all ${canWrite ? 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10 active:scale-95' : 'bg-slate-900/30 border-white/5 text-slate-600 cursor-not-allowed opacity-60'}`}
                                            title={canWrite ? 'Edit' : 'Not allowed'}
                                        >
                                            Edit
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Modal
                open={createOpen}
                title="Create Account"
                onClose={() => { if (!busy) setCreateOpen(false); }}
            >
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <input
                            value={createForm.driver_id}
                            onChange={(e) => setCreateForm((p) => ({ ...p, driver_id: e.target.value }))}
                            placeholder="driver_id (ex: D004)"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30 font-mono"
                        />
                        <input
                            value={createForm.username}
                            onChange={(e) => setCreateForm((p) => ({ ...p, username: e.target.value }))}
                            placeholder="username"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                        />
                    </div>
                    <input
                        value={createForm.name}
                        onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Full name"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />
                    <input
                        value={createForm.password}
                        onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))}
                        placeholder="Temporary password"
                        type="password"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <select
                            value={createForm.role}
                            onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value }))}
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white outline-none focus:ring-2 focus:ring-emerald-500/30"
                        >
                            {roleOptions.map((r) => (
                                <option key={r} value={r}>{r}</option>
                            ))}
                        </select>
                        <label className="flex items-center gap-2 px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white select-none">
                            <input
                                type="checkbox"
                                checked={createForm.active}
                                onChange={(e) => setCreateForm((p) => ({ ...p, active: e.target.checked }))}
                            />
                            <span className="text-xs font-bold">Active</span>
                        </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <input
                            value={createForm.truck_plate}
                            onChange={(e) => setCreateForm((p) => ({ ...p, truck_plate: e.target.value }))}
                            placeholder="Truck plate (optional)"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30 font-mono"
                        />
                        <input
                            value={createForm.phone_number}
                            onChange={(e) => setCreateForm((p) => ({ ...p, phone_number: e.target.value }))}
                            placeholder="Truck phone (optional)"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                        />
                    </div>

                    <input
                        value={createForm.helper_name}
                        onChange={(e) => setCreateForm((p) => ({ ...p, helper_name: e.target.value }))}
                        placeholder="Default helper name (optional)"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />

                    <button
                        type="button"
                        onClick={submitCreate}
                        disabled={!canWrite || busy}
                        className={`w-full btn-premium py-4 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 shadow-lg transition-all ${(!canWrite || busy)
                            ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70'
                            : 'bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white active:scale-[0.99]'
                            }`}
                    >
                        {busy ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                        Create
                    </button>
                </div>
            </Modal>

            <Modal
                open={editOpen}
                title={`Edit Account • ${editUser?.driver_id || ''}`}
                onClose={() => { if (!busy) setEditOpen(false); }}
            >
                <div className="space-y-3">
                    <input
                        value={editForm.name}
                        onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Full name"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30"
                    />
                    <input
                        value={editForm.username}
                        onChange={(e) => setEditForm((p) => ({ ...p, username: e.target.value }))}
                        placeholder="username"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30"
                    />
                    <input
                        value={editForm.password}
                        onChange={(e) => setEditForm((p) => ({ ...p, password: e.target.value }))}
                        placeholder="New password (optional)"
                        type="password"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30"
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <select
                            value={editForm.role}
                            onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value }))}
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white outline-none focus:ring-2 focus:ring-violet-500/30"
                        >
                            {roleOptions.map((r) => (
                                <option key={r} value={r}>{r}</option>
                            ))}
                        </select>
                        <label className="flex items-center gap-2 px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white select-none">
                            <input
                                type="checkbox"
                                checked={editForm.active}
                                onChange={(e) => setEditForm((p) => ({ ...p, active: e.target.checked }))}
                            />
                            <span className="text-xs font-bold">Active</span>
                        </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <input
                            value={editForm.truck_plate}
                            onChange={(e) => setEditForm((p) => ({ ...p, truck_plate: e.target.value }))}
                            placeholder="Truck plate (optional)"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30 font-mono"
                        />
                        <input
                            value={editForm.phone_number}
                            onChange={(e) => setEditForm((p) => ({ ...p, phone_number: e.target.value }))}
                            placeholder="Truck phone (optional)"
                            className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30"
                        />
                    </div>

                    <input
                        value={editForm.helper_name}
                        onChange={(e) => setEditForm((p) => ({ ...p, helper_name: e.target.value }))}
                        placeholder="Default helper name (optional)"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-violet-500/30"
                    />

                    <button
                        type="button"
                        onClick={submitEdit}
                        disabled={!canWrite || busy}
                        className={`w-full btn-premium py-4 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 shadow-lg transition-all ${(!canWrite || busy)
                            ? 'bg-slate-800/40 text-slate-500 cursor-not-allowed opacity-70'
                            : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white active:scale-[0.99]'
                            }`}
                    >
                        {busy ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                        Save Changes
                    </button>
                </div>
            </Modal>
        </motion.div>
    );
}
