import React, { useState, useEffect } from 'react';
import { ArrowLeft, Search, Package, RefreshCw, Filter, ChevronRight, Loader2 } from 'lucide-react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function Shipments() {
    const [shipments, setShipments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState(null);
    const navigate = useNavigate();

    const fetchShipments = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('token');
            const response = await axios.get(`${API_URL}/shipments`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setShipments(response.data);
        } catch (err) {
            console.error('Failed to fetch shipments', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchShipments();
    }, []);

    const filtered = shipments.filter(s =>
        s.awb.toLowerCase().includes(search.toLowerCase()) ||
        (s.recipient_name && s.recipient_name.toLowerCase().includes(search.toLowerCase()))
    );

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
            <div className="p-4 bg-white dark:bg-gray-800 shadow-sm sticky top-0 z-20">
                <div className="flex items-center gap-4 mb-4">
                    <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-gray-600 dark:text-gray-400"><ArrowLeft /></button>
                    <h1 className="flex-1 font-bold text-xl text-gray-900 dark:text-white">Live Tracking</h1>
                    <button onClick={fetchShipments} className="p-2 text-primary-500">
                        <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search AWB, Name or Status"
                        className="w-full pl-12 pr-4 py-4 bg-gray-100 dark:bg-gray-700 rounded-2xl outline-none focus:ring-2 focus:ring-primary-500 text-sm font-medium transition-all"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="flex-1 p-4 space-y-4">
                {loading && shipments.length === 0 ? (
                    <div className="flex flex-col items-center justify-center p-20 text-gray-400">
                        <Loader2 className="animate-spin mb-4 text-primary-500" size={32} />
                        <p className="animate-pulse">Fetching real-time data...</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center p-20 text-gray-400">
                        <Package className="mx-auto mb-4 opacity-10" size={64} />
                        <p>No shipments found in current batch</p>
                    </div>
                ) : (
                    filtered.map((s, idx) => (
                        <div key={idx} className="bg-white dark:bg-gray-800 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden transition-all duration-300">
                            <div
                                onClick={() => setExpanded(expanded === idx ? null : idx)}
                                className="p-5 flex items-center gap-4 active:bg-gray-50 dark:active:bg-gray-700/50 cursor-pointer"
                            >
                                <div className={`p-4 rounded-2xl ${s.status === 'Livrat' ? 'bg-green-50 text-green-600' : 'bg-primary-50 text-primary-600'}`}>
                                    <Package size={24} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-center mb-1">
                                        <h3 className="font-bold text-gray-900 dark:text-white font-mono text-sm uppercase tracking-tighter">{s.awb}</h3>
                                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${s.status === 'Livrat' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                                            }`}>
                                            {s.status || 'Active'}
                                        </span>
                                    </div>
                                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate">{s.recipient_name}</p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <p className="text-[10px] text-gray-400 font-medium truncate flex-1">{s.delivery_address}</p>
                                        {s.weight > 0 && <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-500">{s.weight}kg</span>}
                                    </div>
                                </div>
                                <ChevronRight className={`text-gray-300 transition-transform duration-300 ${expanded === idx ? 'rotate-90' : ''}`} size={20} />
                            </div>

                            {expanded === idx && s.tracking_history && (
                                <div className="px-5 pb-5 pt-2 border-t border-gray-50 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-900/10">
                                    <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-4">Tracking History</h4>
                                    <div className="space-y-4 relative">
                                        <div className="absolute left-2.5 top-2 bottom-2 w-0.5 bg-gray-200 dark:bg-gray-700"></div>
                                        {s.tracking_history.map((event, eIdx) => (
                                            <div key={eIdx} className="flex gap-4 relative">
                                                <div className={`w-5 h-5 rounded-full border-4 border-white dark:border-gray-800 z-10 flex-shrink-0 ${eIdx === 0 ? 'bg-primary-500' : 'bg-gray-300'
                                                    }`}></div>
                                                <div className="flex-1">
                                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-200">{event.eventDescription}</p>
                                                    <p className="text-[10px] text-gray-500 mt-0.5">{event.eventDate} • {event.localityName}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            <div className="p-4 text-center text-[10px] text-gray-400 uppercase tracking-widest">
                Showing {filtered.length} of {shipments.length} Shipments
            </div>
        </div>
    );
}
