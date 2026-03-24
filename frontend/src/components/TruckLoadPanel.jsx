import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Truck, CheckCircle2, ChevronRight, AlertTriangle, Search, GripVertical, ShieldAlert } from 'lucide-react';
import Scanner from './Scanner';
import AwbLink from './AwbLink';
import { normalizeShipmentIdentifier } from '../services/awbScan';
import { apiFinishTruckLoad, apiAddAwbToRoutePlan, listRoutePlans } from '../services/api';

export default function TruckLoadPanel({ open, onClose, user, lang = 'ro' }) {
    const [selectedRoute, setSelectedRoute] = useState(null);
    const [scannedAwbs, setScannedAwbs] = useState(new Set());
    const [scannerOpen, setScannerOpen] = useState(false);
    const [manualAwb, setManualAwb] = useState('');
    const [scanError, setScanError] = useState('');
    const [scanFeedback, setScanFeedback] = useState(null);
    const [manualOverride, setManualOverride] = useState(false);
    
    // Admin specific states
    const isAdmin = String(user?.role || '').toLowerCase() === 'admin' || String(user?.role || '').toLowerCase() === 'manager';
    const [targetDate, setTargetDate] = useState(new Date().toISOString().slice(0, 10));
    
    const [availableRoutes, setAvailableRoutes] = useState([]);
    const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);

    // 1. Fetch available assigned route plans from the server for the target date
    useEffect(() => {
        if (!open || !user?.token) return;
        let isMounted = true;
        setIsLoadingRoutes(true);
        
        listRoutePlans(user.token, { plan_date: targetDate })
            .then(plans => {
                if (!isMounted) return;
                const filtered = (plans || []).filter(r => {
                    const s = String(r.status || '').toLowerCase();
                    return s === 'assigned' || s === 'approved' || s === 'allocated' || s === 'open' || s === 'in progress';
                });
                setAvailableRoutes(filtered);
            })
            .catch(err => console.error("Failed to fetch available routes for load panel:", err))
            .finally(() => {
                if (isMounted) setIsLoadingRoutes(false);
            });
            
        return () => { isMounted = false; };
    }, [open, user, targetDate]);

    // Format the route list into exactly inverted sequence
    const routeLoadSequence = useMemo(() => {
        if (!selectedRoute) return [];
        let dataArr = [];
        if (Array.isArray(selectedRoute.data)) {
            dataArr = selectedRoute.data;
        } else if (selectedRoute.data && Array.isArray(selectedRoute.data.stops)) {
            dataArr = selectedRoute.data.stops;
        }
        if (!dataArr.length) return [];
        // Ensure we load strictly the last delivery item first (LIFO array)
        return [...dataArr].reverse().map(stop => ({
            ...stop,
            normalized_awb: normalizeShipmentIdentifier(stop.awb)
        }));
    }, [selectedRoute]);

    // Track next item to load
    const nextItemToLoad = useMemo(() => {
        return routeLoadSequence.find(stop => !scannedAwbs.has(stop.normalized_awb)) || null;
    }, [routeLoadSequence, scannedAwbs]);

    const loadedCount = scannedAwbs.size;
    const totalCount = routeLoadSequence.length;
    const isComplete = totalCount > 0 && loadedCount >= totalCount;

    // Load progress from localStorage when a route gets selected
    useEffect(() => {
        if (!selectedRoute?.id) return;
        const key = `arynik_truck_loading_${selectedRoute.id}`;
        try {
            const saved = localStorage.getItem(key);
            if (saved) {
                const arr = JSON.parse(saved);
                setScannedAwbs(new Set(arr));
            } else {
                setScannedAwbs(new Set());
            }
        } catch {
            setScannedAwbs(new Set());
        }
    }, [selectedRoute?.id]);

    // Save progress to localStorage
    useEffect(() => {
        if (!selectedRoute?.id) return;
        const key = `arynik_truck_loading_${selectedRoute.id}`;
        try {
            localStorage.setItem(key, JSON.stringify(Array.from(scannedAwbs)));
        } catch {}
    }, [scannedAwbs, selectedRoute?.id]);

    const handleScan = async (rawAwb) => {
        const token = normalizeShipmentIdentifier(rawAwb);
        if (!token) return;
        
        setScanError('');
        setScanFeedback(null);

        if (scannedAwbs.has(token)) {
            const errText = lang === 'ro' ? `Coletele ${token} au fost deja scanate.` : `Shipment ${token} is already scanned.`;
            setScanError(errText);
            setScanFeedback({ type: 'error', text: errText });
            setTimeout(() => setScanFeedback(null), 1800);
            return;
        }

        if (nextItemToLoad && nextItemToLoad.normalized_awb === token) {
            setScannedAwbs(prev => {
                const updated = new Set(prev);
                updated.add(token);
                if (updated.size === totalCount && selectedRoute?.id) {
                    apiFinishTruckLoad(user?.token, selectedRoute.id).catch(err => {
                        console.error("Failed to notify load completion", err);
                    });
                }
                return updated;
            });
            setManualAwb('');
            setScanFeedback({ type: 'success', text: lang === 'ro' ? `${token} ADAUGAT LIFO` : `${token} LIFO LOADED` });
            setTimeout(() => setScanFeedback(null), 1500);
        } else {
            const exists = routeLoadSequence.find(s => s.normalized_awb === token);
            let errText = '';
            if (!exists) {
                if (isAdmin) {
                    if (window.confirm(`Expediția ${token} NU aparține acestei rute!\n\nDoriți să forțați adăugarea ei la ruta ${selectedRoute?.name}?`)) {
                        try {
                            setScanError('');
                            setScanFeedback({ type: 'success', text: 'Se adaugă...' });
                            const newRouteData = await apiAddAwbToRoutePlan(user?.token, selectedRoute.id, token);
                            setSelectedRoute(newRouteData);
                            setScannedAwbs(prev => {
                                const updated = new Set(prev);
                                updated.add(token);
                                // The new total count will be routeLoadSequence.length + 1 in the next render
                                if (updated.size >= (totalCount + 1) && selectedRoute?.id) {
                                    apiFinishTruckLoad(user?.token, selectedRoute.id).catch(e => console.error(e));
                                }
                                return updated;
                            });
                            setManualAwb('');
                            setScanFeedback({ type: 'success', text: `AWB ADAUGAT FORTAT` });
                            setTimeout(() => setScanFeedback(null), 2000);
                        } catch (err) {
                            setScanError(err?.response?.data?.detail || err.message || 'Eroare adăugare forțată');
                        }
                    }
                    return;
                }
                errText = lang === 'ro' ? `Expeditia ${token} nu apartine acestei rute!` : `Shipment ${token} is not on this route!`;
            } else {
                errText = lang === 'ro' 
                    ? `Colete gresite! Te rog sa incarci ${nextItemToLoad.awb} intai pentru o descarcare usoara.` 
                    : `Wrong sequence! Please load ${nextItemToLoad.awb} first for correct unloading.`;
            }
            setScanError(errText);
            setScanFeedback({ type: 'error', text: errText });
            setTimeout(() => setScanFeedback(null), 2500);
        }
    };

    const skipNextItem = () => {
        if (!nextItemToLoad) return;
        setScannedAwbs(prev => {
            const updated = new Set(prev);
            updated.add(nextItemToLoad.normalized_awb);
            if (updated.size === totalCount && selectedRoute?.id) {
                apiFinishTruckLoad(user?.token, selectedRoute.id).catch(err => {
                    console.error("Failed to notify load completion", err);
                });
            }
            return updated;
        });
        setScanError('');
        setScanFeedback({ type: 'success', text: 'AWB SARIT (ADMIN)' });
        setTimeout(() => setScanFeedback(null), 1500);
    };
    
    // Handle opening scanner automatically based on open state
    useEffect(() => {
        if (!open) {
            setSelectedRoute(null);
            setScannedAwbs(new Set());
            setScanError('');
            setScannerOpen(false);
            setManualOverride(false);
            setManualAwb('');
        }
    }, [open]);

    if (!open) return null;

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-sm px-4 py-6 flex items-end sm:items-center justify-center p-2 sm:p-4"
                >
                    <motion.div
                        initial={{ opacity: 0, y: 24, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.98 }}
                        transition={{ duration: 0.2 }}
                        className="w-full max-w-lg max-h-[90vh] overflow-hidden rounded-[32px] border border-white/10 bg-slate-900/95 shadow-2xl flex flex-col"
                    >
                        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-4 glass-strong">
                            <div className="min-w-0">
                                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                                    <Truck className="text-emerald-400" size={20} />
                                    {lang === 'ro' ? 'Incarcare Camion' : 'Load Truck'}
                                </h3>
                                <p className="text-[11px] font-semibold text-slate-400 mt-0.5">
                                    {lang === 'ro'
                                        ? 'Sistem strict LIFO (Last-In, First-Out)'
                                        : 'Strict LIFO mapping sequence'}
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                className="w-10 h-10 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-red-500/20 hover:border-red-500/30 transition-all flex items-center justify-center shrink-0"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-5">
                            
                            {!selectedRoute ? (
                                <div className="space-y-4">
                                    <h4 className="text-sm font-bold text-white uppercase tracking-widest">{lang === 'ro' ? 'Selecteaza Ruta' : "Select Route"}</h4>
                                    
                                    {isAdmin && (
                                        <input 
                                            type="date" 
                                            value={targetDate} 
                                            onChange={e => setTargetDate(e.target.value)}
                                            className="w-full glass-strong border border-white/10 rounded-xl px-4 py-3 text-sm font-bold text-white cursor-pointer hover:border-emerald-500/50 outline-none transition-colors"
                                        />
                                    )}

                                    {isLoadingRoutes ? (
                                        <div className="p-6 text-center border-2 border-dashed border-white/10 rounded-3xl glass-light">
                                            <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin mx-auto mb-3"></div>
                                            <p className="text-sm font-medium text-white/70">
                                                {lang === 'ro' ? 'Se incarca rutele...' : 'Loading routes...'}
                                            </p>
                                        </div>
                                    ) : availableRoutes.length === 0 ? (
                                        <div className="p-6 text-center border-2 border-dashed border-white/10 rounded-3xl glass-light">
                                            <AlertTriangle className="text-amber-400 mx-auto mb-3" size={32} />
                                            <p className="text-sm font-bold text-slate-300">
                                                {lang === 'ro' ? 'Nu exista rute alocate' : 'No routes assigned today'}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="grid gap-3">
                                            {availableRoutes.map(r => (
                                                <button
                                                    key={r.id}
                                                    onClick={() => setSelectedRoute(r)}
                                                    className="w-full text-left p-4 rounded-2xl glass-strong border border-white/10 hover:border-emerald-500/50 hover:bg-emerald-500/10 transition-all group relative overflow-hidden"
                                                >
                                                    <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/20 blur-xl rounded-full translate-x-8 -translate-y-8 group-hover:scale-150 transition-transform"></div>
                                                    <p className="text-sm font-black text-white relative z-10">{r.name}</p>
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest relative z-10 mt-1">
                                                        {Array.isArray(r.data?.stops) ? r.data.stops.length : (Array.isArray(r.data) ? r.data.length : 0)} {lang === 'ro' ? 'Opriri' : 'Stops'}
                                                        {r.vehicle_plate ? ` • ${r.vehicle_plate}` : (r.assigned_vehicle_plate ? ` • ${r.assigned_vehicle_plate}` : '')}
                                                    </p>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    
                                    {/* Progress Bar */}
                                    <div className="glass-strong p-4 rounded-2xl border border-white/10">
                                        <div className="flex justify-between items-end mb-2">
                                            <div>
                                                <div className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">
                                                    {lang === 'ro' ? 'Progres Incarcare' : 'Loading Progress'}
                                                </div>
                                                <div className="text-2xl font-black text-white mt-1">
                                                    {loadedCount} <span className="text-slate-500 text-lg">/ {totalCount}</span>
                                                </div>
                                            </div>
                                            {isComplete && (
                                                <div className="flex items-center gap-1.5 text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-full border border-emerald-500/20">
                                                    <CheckCircle2 size={16} />
                                                    <span className="text-xs font-bold tracking-wide uppercase">Complet</span>
                                                </div>
                                            )}
                                        </div>
                                        <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden flex">
                                            <motion.div 
                                                className="bg-emerald-500 h-full rounded-full"
                                                initial={{ width: 0 }}
                                                animate={{ width: `${totalCount > 0 ? (loadedCount / totalCount) * 100 : 0}%` }}
                                            />
                                        </div>
                                    </div>

                                    {/* Scan Error */}
                                    <AnimatePresence>
                                        {scanError && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                className="bg-red-500/10 border border-red-500/30 rounded-2xl overflow-hidden"
                                            >
                                                <div className="p-4 flex gap-3 text-red-400">
                                                    <AlertTriangle size={20} className="shrink-0 mt-0.5" />
                                                    <p className="text-xs font-bold leading-relaxed">{scanError}</p>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>

                                    {/* Next Target AWB */}
                                    {!isComplete && nextItemToLoad && (
                                        <div className="bg-gradient-to-br from-emerald-600/20 to-teal-900/40 border border-emerald-500/30 p-6 rounded-[28px] relative overflow-hidden shadow-inner-glow">
                                            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 blur-3xl rounded-full"></div>
                                            <div className="relative z-10 text-center space-y-4">
                                                <div className="text-xs font-black uppercase tracking-widest text-emerald-300">
                                                    {lang === 'ro' ? 'Urmatorul Colet de Incarcat:' : 'Next Parcel to Load:'}
                                                </div>
                                                <div className="text-4xl font-black tracking-tight text-white font-mono break-all px-2">
                                                    {nextItemToLoad.awb}
                                                </div>
                                                <div className="text-sm font-bold text-slate-300 bg-black/20 rounded-xl p-3 border border-white/5 break-words">
                                                    <MapPinned className="inline-block mr-2 text-emerald-400 -mt-1" size={16} />
                                                    {nextItemToLoad.recipient_name || 'Client'}: {nextItemToLoad.delivery_address || nextItemToLoad.locality || 'N/A'}
                                                </div>
                                                
                                                <div className="pt-2 flex flex-col gap-3">
                                                    <button
                                                        onClick={() => setScannerOpen(true)}
                                                        className="w-full btn-premium py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                                                    >
                                                        <Search size={20} />
                                                        {lang === 'ro' ? 'Deschide Scanner' : 'Open Scanner'}
                                                    </button>
                                                    
                                                    {manualOverride ? (
                                                        <div className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                value={manualAwb}
                                                                onChange={e => setManualAwb(e.target.value)}
                                                                onKeyDown={e => e.key === 'Enter' && handleScan(manualAwb)}
                                                                placeholder="Type AWB..."
                                                                className="flex-1 glass-strong border border-white/10 rounded-xl px-4 py-2 text-sm font-bold text-white outline-none focus:border-emerald-500"
                                                            />
                                                            <button
                                                                onClick={() => handleScan(manualAwb)}
                                                                className="bg-emerald-500/20 text-emerald-300 px-4 rounded-xl font-bold border border-emerald-500/30"
                                                            >
                                                                OK
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => setManualOverride(true)}
                                                            className="text-xs font-bold text-slate-500 hover:text-white transition-colors"
                                                        >
                                                            Keyboard Input
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Admin Overrides */}
                                    {!isComplete && isAdmin && nextItemToLoad && (
                                        <div className="glass-light border border-amber-500/30 p-4 rounded-2xl relative overflow-hidden group">
                                            <div className="flex items-start justify-between gap-4">
                                                <div>
                                                    <h5 className="text-[10px] font-black uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
                                                        <ShieldAlert size={14} />
                                                        Admin Override
                                                    </h5>
                                                    <p className="text-[10px] text-slate-400 mt-1 font-bold">
                                                        Colet lipsa? Poti sari peste acest AWB pentru a debloca manipularea.
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={skipNextItem}
                                                    className="shrink-0 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all"
                                                >
                                                    SKIP AWB
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Route Preview */}
                                    <div className="pt-4">
                                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 px-1">
                                            {lang === 'ro' ? 'Ordinea Incarcarii (Jos in Sus)' : 'Loading Order (Bottom to Top)'}
                                        </h4>
                                        <div className="space-y-2">
                                            {routeLoadSequence.map((stop, idx) => {
                                                const loaded = scannedAwbs.has(stop.normalized_awb);
                                                const isNext = !loaded && nextItemToLoad?.normalized_awb === stop.normalized_awb;
                                                
                                                return (
                                                    <div 
                                                        key={stop.normalized_awb + idx} 
                                                        className={`flex items-center gap-3 p-3 rounded-2xl border transition-all ${
                                                            loaded ? 'bg-emerald-500/5 border-emerald-500/20 opacity-50' : 
                                                            isNext ? 'bg-emerald-500/10 border-emerald-500/40 shadow-glow-sm' : 
                                                            'glass-light border-white/5 opacity-70'
                                                        }`}
                                                    >
                                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${
                                                            loaded ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' :
                                                            isNext ? 'bg-emerald-500 text-white shadow-glow-sm' :
                                                            'bg-white/5 border-white/10 text-slate-500'
                                                        }`}>
                                                            {loaded ? <CheckCircle2 size={16} /> : <span className="text-xs font-black">{totalCount - idx}</span>}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className={`text-xs font-black uppercase font-mono tracking-wider truncate cursor-pointer ${
                                                                loaded ? 'text-emerald-400/70 line-through' : isNext ? 'text-emerald-300' : 'text-slate-300'
                                                            }`}>
                                                                <AwbLink awb={stop.awb} className="hover:underline">{stop.awb}</AwbLink>
                                                            </div>
                                                            <div className="text-[10px] text-slate-500 font-bold truncate">
                                                                {stop.recipient_name || 'Client'}: {stop.delivery_address || stop.locality || 'N/A'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    
                                </div>
                            )}

                        </div>
                    </motion.div>
                </motion.div>
            )}

            {scannerOpen && (
                <Scanner
                    continuous={true}
                    scanFeedback={scanFeedback}
                    onClose={() => setScannerOpen(false)}
                    onScan={handleScan}
                />
            )}
        </AnimatePresence>
    );
}
