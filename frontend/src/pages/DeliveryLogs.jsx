import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getDeliveryLogs } from '../services/api';
import { Image, MapPin, X, AlertTriangle } from 'lucide-react';

function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    const R = 6371e3; // metres
    const ang1 = lat1 * Math.PI / 180;
    const ang2 = lat2 * Math.PI / 180;
    const deltaAng = (lat2 - lat1) * Math.PI / 180;
    const deltaLon = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaAng / 2) * Math.sin(deltaAng / 2) +
              Math.cos(ang1) * Math.cos(ang2) *
              Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
}

export default function DeliveryLogs() {
    const { user } = useAuth();
    const token = user?.token;
    
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    
    const [awbQuery, setAwbQuery] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    
    const [selectedLog, setSelectedLog] = useState(null);

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            loadLogs();
        }, 500);
        return () => clearTimeout(timeoutId);
    }, [token, awbQuery, dateFrom, dateTo]);

    const loadLogs = async () => {
        try {
            setLoading(true);
            const data = await getDeliveryLogs(token, 200, awbQuery, dateFrom ? new Date(dateFrom).toISOString() : '', dateTo ? new Date(dateTo).toISOString() : '');
            setLogs(data);
            setError(null);
        } catch (err) {
            console.error('Failed to load delivery logs:', err);
            setError('Nu s-au putut încărca logurile de livrare.');
        } finally {
            setLoading(false);
        }
    };
    const hasProof = (log) => {
        const pod = log.data?.pod || {};
        return !!(pod.photo?.data_url || pod.signature?.data_url || (pod.photos && Object.values(pod.photos).some(p => p?.data_url)) || log.data?.cod?.receipt_photo?.data_url || log.data?.buy_back?.photo?.data_url);
    };

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                    Jurnal Livrări
                </h1>
                <div className="flex flex-col sm:flex-row items-center gap-3 w-full lg:w-auto">
                    <input
                        type="text"
                        placeholder="Caută AWB..."
                        value={awbQuery}
                        onChange={(e) => setAwbQuery(e.target.value)}
                        className="w-full sm:w-48 bg-[#1a1c24] text-white border border-white/[0.1] rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => setDateFrom(e.target.value)}
                            className="w-full sm:w-auto bg-[#1a1c24] text-white border border-white/[0.1] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                        <span className="text-slate-500">-</span>
                        <input
                            type="date"
                            value={dateTo}
                            onChange={(e) => setDateTo(e.target.value)}
                            className="w-full sm:w-auto bg-[#1a1c24] text-white border border-white/[0.1] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                    </div>
                    <button
                        onClick={loadLogs}
                        className="w-full sm:w-auto px-4 py-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors text-sm font-medium whitespace-nowrap"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {loading && logs.length === 0 ? (
                <div className="p-6 text-center text-slate-400">Încărcare date...</div>
            ) : error ? (
                <div className="p-6 text-center text-red-500">{error}</div>
            ) : (
                <div className="bg-[#12141c] border border-white/[0.05] rounded-xl overflow-hidden shadow-2xl">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="bg-[#1a1c24] border-b border-white/[0.05]">
                                <tr>
                                    <th className="px-6 py-4 font-medium text-slate-300">Data & Ora</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">AWB</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">Curier</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">Destinatar</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">Locație</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">Status</th>
                                    <th className="px-6 py-4 font-medium text-slate-300">Dovadă (POD)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.02]">
                                {logs.length === 0 ? (
                                    <tr>
                                        <td colSpan="7" className="px-6 py-8 text-center text-slate-500">
                                            Nu s-au găsit livrări conform filtrelurs.
                                        </td>
                                    </tr>
                                ) : (
                                    logs.map((log) => (
                                        <tr key={log.id} className="hover:bg-white/[0.02] transition-colors group">
                                            <td className="px-6 py-4 text-slate-400">
                                                {log.completed_at ? new Date(log.completed_at).toLocaleString('ro-RO') : '-'}
                                            </td>
                                            <td className="px-6 py-4 font-bold text-white whitespace-normal align-top">
                                                <div>{log.awb}</div>
                                                {(typeof log.delivery_instructions === 'string' && 
                                                 (log.delivery_instructions.toLowerCase().includes('buy') || log.delivery_instructions.toLowerCase().includes('rabla') || log.delivery_instructions.toLowerCase().includes('bib'))) && (
                                                    <div className="mt-2 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 p-2 rounded-lg max-w-[200px] flex items-start gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                                        <div className="leading-tight">
                                                            <span className="font-bold uppercase block mb-0.5">Atenție BIB:</span>
                                                            <span className="font-normal">{log.delivery_instructions}</span>
                                                        </div>
                                                    </div>
                                                )}
                                                {log.data?.buy_back && !(typeof log.delivery_instructions === 'string' && (log.delivery_instructions.toLowerCase().includes('buy') || log.delivery_instructions.toLowerCase().includes('rabla') || log.delivery_instructions.toLowerCase().includes('bib'))) && (
                                                    <div className="mt-2 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 p-2 rounded-lg max-w-[200px] flex items-start gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                                        <div className="leading-tight">
                                                            <span className="font-bold uppercase block mb-0.5">Atenție BIB:</span>
                                                            <span className="font-normal">Colectare Neanunțată / Deseu (Ales de Sofer)</span>
                                                        </div>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-indigo-300">
                                                {log.driver_name || log.driver_id}
                                                {log.truck_plate && <span className="ml-2 text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{log.truck_plate}</span>}
                                            </td>
                                            <td className="px-6 py-4 text-slate-300">
                                                {log.recipient_name || '-'}
                                            </td>
                                            <td className="px-6 py-4 whitespace-normal min-w-[200px] max-w-sm align-top">
                                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Destinație Așteptată:</div>
                                                <div className="text-sm font-medium text-slate-100 leading-tight mb-1">
                                                    {log.delivery_address || [log.locality, log.county].filter(Boolean).join(', ') || '-'}
                                                </div>
                                                {(!log.delivery_address && (log.locality || log.county)) ? null : (
                                                    <div className="text-xs text-slate-500 mb-2">
                                                        {[log.locality, log.county].filter(Boolean).join(', ')}
                                                    </div>
                                                )}
                                                
                                                <div className="mt-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Locație Acțiune:</div>
                                                <div className="flex flex-col gap-2">
                                                    {log.last_latitude && log.last_longitude ? (
                                                        <a
                                                            href={`https://maps.google.com/?q=${log.last_latitude},${log.last_longitude}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 w-fit px-2 py-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/20"
                                                        >
                                                            <MapPin className="w-3.5 h-3.5" />
                                                            Harta GPS
                                                        </a>
                                                    ) : (
                                                        <span className="text-xs text-slate-500">-</span>
                                                    )}
                                                    
                                                    {(() => {
                                                        const dist = calculateDistance(log.shipment_latitude, log.shipment_longitude, log.last_latitude, log.last_longitude);
                                                        if (dist !== null) {
                                                            const isFar = dist > 500;
                                                            return (
                                                                <div className={`text-[10px] font-bold px-2 py-1 rounded w-fit ${isFar ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"}`}>
                                                                    Abatere loc. livrare: {dist >= 1000 ? (dist/1000).toFixed(1) + ' km' : dist + ' m'}
                                                                </div>
                                                            );
                                                        }
                                                        return null;
                                                    })()}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold ${
                                                    log.state === 'Done' || log.state === 'Completed'
                                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                                                        : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                                }`}>
                                                    {log.state}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                {hasProof(log) ? (
                                                    <button
                                                        onClick={() => setSelectedLog(log)}
                                                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg shadow-lg shadow-indigo-500/20 transition-all font-medium text-sm"
                                                    >
                                                        <Image className="w-4 h-4" />
                                                        Vezi Dovada
                                                    </button>
                                                ) : (
                                                    <span className="text-slate-600 italic text-sm">Fără dovadă</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Proof Modal */}
            {selectedLog && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
                    <div className="relative w-full max-w-2xl bg-[#1a1c24] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
                        <div className="flex items-center justify-between p-4 border-b border-white/10">
                            <div>
                                <h3 className="text-lg font-bold text-white">Dovadă Livrare</h3>
                                <p className="text-sm text-slate-400">AWB: {selectedLog.awb}</p>
                            </div>
                            <button
                                onClick={() => setSelectedLog(null)}
                                className="p-2 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-xl transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        
                        <div className="p-6 overflow-y-auto space-y-6">
                            {selectedLog.data?.pod?.signature?.data_url && (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Semnătură Client</h4>
                                    <div className="bg-white rounded-xl p-4 flex justify-center border border-white/20">
                                        <img src={selectedLog.data.pod.signature.data_url} alt="Semnatura" className="max-h-48 object-contain" />
                                    </div>
                                </div>
                            )}
                            
                            {selectedLog.data?.pod?.photos && Object.values(selectedLog.data.pod.photos).some(p => p?.data_url) && (
                                <div className="space-y-4">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Poze Livrare</h4>
                                    
                                    <h5 className="text-[11px] font-bold text-slate-400">Înainte de desfacere</h5>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                        {[
                                            { key: 'box1', label: 'Fața 1' },
                                            { key: 'box2', label: 'Fața 2' },
                                            { key: 'box3', label: 'Fața 3' },
                                            { key: 'box4', label: 'Fața 4' },
                                        ].map(slot => selectedLog.data.pod.photos[slot.key]?.data_url ? (
                                            <div key={slot.key} className="space-y-1">
                                                <div className="bg-[#12141c] rounded-xl overflow-hidden border border-white/10 aspect-square flex justify-center items-center">
                                                    <img src={selectedLog.data.pod.photos[slot.key].data_url} alt={slot.label} className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" onClick={() => window.open(selectedLog.data.pod.photos[slot.key].data_url, '_blank')} />
                                                </div>
                                                <p className="text-center text-[10px] text-slate-400 uppercase tracking-widest">{slot.label}</p>
                                            </div>
                                        ) : null)}
                                    </div>
                                    
                                    {(selectedLog.data.pod.photos.unwrapped?.data_url || selectedLog.data.pod.photos.packaging?.data_url || selectedLog.data.pod.photos.extra?.data_url) && (
                                        <>
                                            <h5 className="text-[11px] font-bold text-slate-400 mt-4">După desfacere</h5>
                                            <div className="grid grid-cols-3 gap-3">
                                                {[
                                                    { key: 'unwrapped', label: 'Produs' },
                                                    { key: 'packaging', label: 'Ambalaje' },
                                                    { key: 'extra', label: 'Extra' },
                                                ].map(slot => selectedLog.data.pod.photos[slot.key]?.data_url ? (
                                                    <div key={slot.key} className="space-y-1">
                                                        <div className="bg-[#12141c] rounded-xl overflow-hidden border border-white/10 aspect-square flex justify-center items-center">
                                                            <img src={selectedLog.data.pod.photos[slot.key].data_url} alt={slot.label} className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" onClick={() => window.open(selectedLog.data.pod.photos[slot.key].data_url, '_blank')} />
                                                        </div>
                                                        <p className="text-center text-[10px] text-slate-400 uppercase tracking-widest">{slot.label}</p>
                                                    </div>
                                                ) : null)}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {selectedLog.data?.pod?.photo?.data_url && (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Poză Locație / Pachet (Veche)</h4>
                                    <div className="bg-[#12141c] rounded-xl overflow-hidden border border-white/10 flex justify-center">
                                        <img src={selectedLog.data.pod.photo.data_url} alt="Poza" className="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity" onClick={() => window.open(selectedLog.data.pod.photo.data_url, '_blank')} />
                                    </div>
                                </div>
                            )}

                            {selectedLog.data?.cod?.receipt_photo?.data_url && (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Poză Chitanță (Ramburs)</h4>
                                    <div className="bg-[#12141c] rounded-xl overflow-hidden border border-white/10 flex justify-center">
                                        <img src={selectedLog.data.cod.receipt_photo.data_url} alt="Chitanta" className="max-w-full rounded-lg" />
                                    </div>
                                    {selectedLog.data?.cod?.amount_collected && (
                                        <div className="text-sm text-amber-400 font-bold text-center mt-2">
                                            Suma încasată: {selectedLog.data.cod.amount_collected} RON
                                        </div>
                                    )}
                                </div>
                            )}

                            {selectedLog.data?.buy_back?.photo?.data_url && (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Poză Buy-Back (Deșeu)</h4>
                                    <div className="bg-[#12141c] rounded-xl overflow-hidden border border-white/10 flex justify-center">
                                        <img src={selectedLog.data.buy_back.photo.data_url} alt="Buy Back" className="max-w-full rounded-lg" />
                                    </div>
                                </div>
                            )}
                            
                            {selectedLog.notes && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Note Curier</h4>
                                    <div className="p-4 bg-white/5 rounded-xl border border-white/10 text-slate-300 text-sm whitespace-pre-wrap">
                                        {selectedLog.notes}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
