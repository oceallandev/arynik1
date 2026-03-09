import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, MapPinned, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getApiUrl, getApiUrlIssue, getPostisSyncStatus, getShipments, triggerPostisSync } from '../services/api';
import { MOLDOVA_COUNTIES, createRoute, deleteRoute, generateDailyMoldovaCountyRoutes, listMoldovaCountyRoutesForDateForUser, listRoutesForUser, resolveRouteDriverIdForUser, routeCrewLabel, routeDisplayName } from '../services/routesStore';
import { useAuth } from '../context/AuthContext';
import { hasPermission } from '../auth/rbac';
import { PERM_POSTIS_SYNC } from '../auth/permissions';

const countyKey = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    } catch {
        return String(value || '').trim().toLowerCase();
    }
};

const makeEmptyDailyIssues = () => ({
    missing_county_awbs: [],
    outside_region_awbs: [],
});

export default function Routes() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const canSyncPostis = hasPermission(user, PERM_POSTIS_SYNC);
    const isAdmin = String(user?.role || '').trim() === 'Admin';

    const [routes, setRoutes] = useState([]);
    const [name, setName] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [vehiclePlate, setVehiclePlate] = useState(() => {
        try {
            return localStorage.getItem('arynik_last_vehicle_plate_v1') || '';
        } catch {
            return '';
        }
    });

    const [dailyRoutes, setDailyRoutes] = useState([]);
    const [dailyLoading, setDailyLoading] = useState(false);
    const [dailyMsg, setDailyMsg] = useState('');
    const [dailyIssues, setDailyIssues] = useState(() => makeEmptyDailyIssues());
    const [openIssueList, setOpenIssueList] = useState('');
    const [postisBusy, setPostisBusy] = useState(false);

    const refresh = () => setRoutes(listRoutesForUser(user));
    const refreshDaily = () => setDailyRoutes(listMoldovaCountyRoutesForDateForUser(date, user));

    useEffect(() => {
        refresh();
    }, []);

    useEffect(() => {
        // Ensure the 7 county routes exist for the selected day so the buttons are always available.
        // Allocation of AWBs is done via the "Generate" action (which also does an upsert).
        if (isAdmin) {
            try {
                const existing = listMoldovaCountyRoutesForDateForUser(date, user);
                if (!existing || existing.length < MOLDOVA_COUNTIES.length) {
                    generateDailyMoldovaCountyRoutes({ date, shipments: [], driver_id: resolveRouteDriverIdForUser(user) });
                }
            } catch { }
        }

        refresh();
        refreshDaily();
        setOpenIssueList('');
        setDailyIssues(makeEmptyDailyIssues());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date, user?.role, user?.driver_id]);

    const handleCreate = () => {
        const ownerDriverId = resolveRouteDriverIdForUser(user);
        const trimmed = String(name || '').trim();
        const baseName = trimmed || `Route ${new Date().toLocaleDateString()}`;
        const plate = String(vehiclePlate || '').trim().toUpperCase();
        const route = createRoute({
            name: baseName,
            driver_id: ownerDriverId,
            driver_name: user?.name || null,
            helper_name: user?.helper_name || null,
            vehicle_plate: plate || null,
            date
        });
        setName('');
        if (plate) {
            try { localStorage.setItem('arynik_last_vehicle_plate_v1', plate); } catch { }
        }
        refresh();
        navigate(`/routes/${route.id}`);
    };

    const generateDaily = async () => {
        if (!isAdmin) {
            setDailyMsg('Doar admin poate genera rutele zilnice.');
            return;
        }
        setDailyLoading(true);
        setDailyMsg('');
        setOpenIssueList('');
        setDailyIssues(makeEmptyDailyIssues());
        try {
            const token = user?.token;
            const shipments = await getShipments(token);
            const summary = generateDailyMoldovaCountyRoutes({
                date,
                shipments,
                driver_id: resolveRouteDriverIdForUser(user)
            });
            const missingCountyAwbs = Array.isArray(summary?.missing_county_awbs) ? summary.missing_county_awbs : [];
            const outsideRegionAwbs = Array.isArray(summary?.outside_region_awbs) ? summary.outside_region_awbs : [];
            setDailyIssues({
                missing_county_awbs: missingCountyAwbs,
                outside_region_awbs: outsideRegionAwbs,
            });

            setDailyMsg(
                `Created ${summary.created_routes} routes • Allocated ${summary.allocated_awbs} AWBs • Moldova deliverables: ${summary.deliverable_in_moldova}`
                + (missingCountyAwbs.length ? ` • Missing county: ${missingCountyAwbs.length}` : '')
                + (outsideRegionAwbs.length ? ` • Outside region: ${outsideRegionAwbs.length}` : '')
            );
        } catch (e) {
            console.warn('Daily route generation failed', e);
            setDailyIssues(makeEmptyDailyIssues());
            setDailyMsg('Failed to generate daily routes (check API / shipment sync).');
        } finally {
            setDailyLoading(false);
            refresh();
            refreshDaily();
        }
    };

    const syncPostis = async () => {
        if (!canSyncPostis || postisBusy) return;
        const apiUrl = getApiUrl();
        const issue = getApiUrlIssue(apiUrl);
        if (issue) {
            setDailyMsg(`${issue} Current: ${apiUrl}`);
            return;
        }
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            'Sync shipments with Postis now?\n\nThis will run a FULL backfill (cost/content/address/raw payload) into the server database.\nIt may take several minutes.'
        );
        if (!ok) return;

        const token = user?.token;
        if (!token) {
            setDailyMsg('Not signed in.');
            return;
        }

        setPostisBusy(true);
        setDailyMsg('');
        try {
            const started = await triggerPostisSync(token, { mode: 'full' });
            const didStart = Boolean(started?.started);
            setDailyMsg(didStart ? 'Postis sync started. Wait 1-3 minutes, then press Generate.' : 'Postis sync is already running.');

            // Quick status poll so the UI reflects immediate failures (auth/config).
            const deadline = Date.now() + 20 * 1000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const st = await getPostisSyncStatus(token);
                if (!st?.running) break;
            }
            const st = await getPostisSyncStatus(token);
            if (st?.last_error) setDailyMsg(`Postis sync failed: ${st.last_error}`);
        } catch (e) {
            if (Number(e?.response?.status) === 405) {
                const api = getApiUrl();
                setDailyMsg(`Sync failed (HTTP 405). Your API URL is not a backend server (likely GitHub Pages). Set Backend API URL in Settings to your FastAPI backend (/docs). Current: ${api}`);
                return;
            }
            const detail = e?.response?.data?.detail || e?.message || 'Failed to sync with Postis.';
            setDailyMsg(String(detail));
        } finally {
            setPostisBusy(false);
        }
    };

    const handleDelete = (routeId) => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm('Delete this route?');
        if (!ok) return;
        deleteRoute(routeId);
        refresh();
    };

    const dailyByCounty = useMemo(() => {
        const map = new Map();
        (Array.isArray(dailyRoutes) ? dailyRoutes : []).forEach((r) => {
            const key = countyKey(r?.county || r?.name);
            if (!key) return;
            map.set(key, r);
        });
        return map;
    }, [dailyRoutes]);

    const missingCountyCount = Array.isArray(dailyIssues?.missing_county_awbs) ? dailyIssues.missing_county_awbs.length : 0;
    const outsideRegionCount = Array.isArray(dailyIssues?.outside_region_awbs) ? dailyIssues.outside_region_awbs.length : 0;
    const hasIssueLists = missingCountyCount > 0 || outsideRegionCount > 0;
    const issueListItems = openIssueList === 'outside_region'
        ? (Array.isArray(dailyIssues?.outside_region_awbs) ? dailyIssues.outside_region_awbs : [])
        : (Array.isArray(dailyIssues?.missing_county_awbs) ? dailyIssues.missing_county_awbs : []);
    const issueListTitle = openIssueList === 'outside_region'
        ? 'AWB-uri Outside Region'
        : 'AWB-uri Missing County';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div>
                    <h1 className="text-xl font-black text-gradient tracking-tight">Routes</h1>
                    <p className="text-xs text-slate-400 font-medium mt-1">Create routes and allocate AWBs</p>
                </div>
                <div className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10">
                    <MapPinned size={20} className="text-emerald-400" />
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 space-y-6 relative z-10">
                {/* Daily Moldova Routes */}
                {isAdmin ? (
                    <div className="glass-strong p-5 rounded-3xl border-iridescent space-y-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Daily Routes (Moldova)</p>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1 truncate">
                                Bacau, Iasi, Neamt, Vrancea, Botosani, Suceava, Vaslui
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className="px-3 py-2 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-xs font-bold"
                            />
                            {canSyncPostis ? (
                                <button
                                    onClick={syncPostis}
                                    disabled={postisBusy}
                                    className={`px-3 py-2 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2 ${postisBusy ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5'}`}
                                    title="Sync shipment details from Postis"
                                >
                                    <RefreshCw size={14} className={postisBusy ? 'animate-spin' : ''} />
                                    Sync
                                </button>
                            ) : null}
                            <button
                                onClick={generateDaily}
                                disabled={dailyLoading}
                                className={`px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2 ${dailyLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
                                title="Create the 7 county routes and auto-allocate deliverable AWBs"
                            >
                                <RefreshCw size={14} className={dailyLoading ? 'animate-spin' : ''} />
                                Generate
                            </button>
                        </div>
                    </div>

                    {dailyMsg && (
                        <div className="glass-light p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold">
                            {dailyMsg}
                        </div>
                    )}

                    {hasIssueLists ? (
                        <div className="glass-light p-4 rounded-2xl border border-amber-500/30 space-y-3">
                            <p className="text-[10px] text-amber-200 font-black uppercase tracking-widest">
                                Erori rutare - apasa pentru lista AWB
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {missingCountyCount > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => setOpenIssueList('missing_county')}
                                        className="px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/35 text-amber-100 text-[10px] font-black uppercase tracking-widest hover:bg-amber-500/25 transition-all"
                                    >
                                        Missing County ({missingCountyCount})
                                    </button>
                                ) : null}
                                {outsideRegionCount > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => setOpenIssueList('outside_region')}
                                        className="px-3 py-2 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-100 text-[10px] font-black uppercase tracking-widest hover:bg-rose-500/25 transition-all"
                                    >
                                        Outside Region ({outsideRegionCount})
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-3">
                        {MOLDOVA_COUNTIES.map((c) => {
                            const r = dailyByCounty.get(countyKey(c.name));
                            const stops = Array.isArray(r?.awbs) ? r.awbs.length : 0;
                            const crew = r ? routeCrewLabel(r) : '';
                            return (
                                <button
                                    key={c.code}
                                    onClick={() => r && navigate(`/routes/${r.id}`)}
                                    disabled={!r}
                                    className={`p-4 rounded-3xl border transition-all text-left flex items-center justify-between gap-3 ${r ? 'glass-strong border-white/10 hover:border-emerald-500/30' : 'bg-slate-900/30 border-slate-800/50 opacity-60 cursor-not-allowed'}`}
                                    title={r ? 'Open route' : 'Generate routes first'}
                                >
                                    <div className="min-w-0">
                                        <p className="text-white font-black truncate">{c.name}</p>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                            {date} • {stops} stops
                                        </p>
                                        {crew && (
                                            <p className="text-[10px] text-emerald-200 font-black uppercase tracking-wide mt-1 truncate">
                                                {crew}
                                            </p>
                                        )}
                                    </div>
                                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center border ${r ? 'bg-emerald-500/15 border-emerald-500/20 text-emerald-300' : 'bg-slate-800/30 border-white/5 text-slate-500'}`}>
                                        <ArrowRight size={18} />
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    </div>
                ) : null}

                {/* Create */}
                <div className="glass-strong p-5 rounded-3xl border-iridescent space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">New Route</p>
                        <span className="text-[10px] font-bold text-slate-500">
                            Driver: <span className="text-slate-300 font-mono">{user?.name || user?.driver_id || 'N/A'}</span>
                        </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Route label (optional)"
                            className="col-span-2 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            value={vehiclePlate}
                            onChange={(e) => setVehiclePlate(e.target.value)}
                            placeholder="Vehicle plate (ex: BC75ARI)"
                            className="col-span-3 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono tracking-wider"
                        />
                    </div>
                    <button
                        onClick={handleCreate}
                        className="w-full btn-premium py-4 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                    >
                        <Plus size={18} />
                        Create Route
                    </button>
                </div>

                {/* List */}
                {routes.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <MapPinned className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No routes yet</p>
                        <p className="text-sm mt-2 text-slate-500">Create your first route above</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            Your Routes
                        </h3>
                        {routes.map((r) => (
                            <div
                                key={r.id}
                                className="glass-strong p-5 rounded-3xl border border-white/10 hover:border-emerald-500/30 transition-all group"
                            >
                                <div className="flex items-start gap-4">
                                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 flex items-center justify-center shadow-glow-sm">
                                        <MapPinned size={18} className="text-white" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-white font-black truncate">{routeDisplayName(r)}</p>
                                                {(String(r?.county || r?.name || '').trim() && String(r?.county || r?.name || '').trim() !== routeDisplayName(r)) && (
                                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wide mt-1 truncate">
                                                        {String(r?.county || r?.name || '').trim()}
                                                    </p>
                                                )}
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                    {r.date || 'No date'} • {Array.isArray(r.awbs) ? r.awbs.length : 0} stops{r.vehicle_plate ? ` • ${r.vehicle_plate}` : ''}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => handleDelete(r.id)}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                    title="Delete route"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                                <button
                                                    onClick={() => navigate(`/routes/${r.id}`)}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-emerald-400 hover:bg-emerald-500/10 active:scale-95 transition-all"
                                                    title="Open route"
                                                >
                                                    <ArrowRight size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {openIssueList ? (
                <div
                    className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center"
                    onClick={() => setOpenIssueList('')}
                >
                    <div
                        className="w-full max-w-lg max-h-[80vh] glass-strong rounded-3xl border border-white/15 overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-white uppercase tracking-widest truncate">{issueListTitle}</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">
                                    {issueListItems.length} AWB-uri
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpenIssueList('')}
                                className="p-2 rounded-xl glass-light border border-white/10 text-slate-300 hover:text-white"
                                aria-label="Inchide"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="p-3 overflow-y-auto max-h-[60vh] space-y-2">
                            {issueListItems.length === 0 ? (
                                <div className="p-3 text-xs font-bold text-slate-400">Niciun AWB in aceasta categorie.</div>
                            ) : issueListItems.map((item, idx) => {
                                const awb = String(item?.awb || '').trim();
                                const recipient = String(item?.recipient_name || '').trim();
                                const locality = String(item?.locality || '').trim();
                                const county = String(item?.county || '').trim();
                                return (
                                    <div key={`${awb || 'awb'}-${idx}`} className="p-3 rounded-2xl border border-white/10 bg-slate-900/35">
                                        <p className="text-[11px] font-mono font-black text-emerald-300 tracking-wider truncate">{awb || 'AWB necunoscut'}</p>
                                        {recipient ? (
                                            <p className="text-xs font-bold text-white mt-1 truncate">{recipient}</p>
                                        ) : null}
                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1 truncate">
                                            {openIssueList === 'outside_region'
                                                ? (county ? `Judet: ${county}` : 'Judet: necunoscut')
                                                : (locality ? `Localitate: ${locality}` : 'Localitate: necunoscuta')}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            ) : null}
        </motion.div>
    );
}
