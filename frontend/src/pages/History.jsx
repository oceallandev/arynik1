import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle, Clock, RefreshCw } from 'lucide-react';
import { getQueue } from '../store/queue';
import { getLogs } from '../services/api';

export default function HistoryPage() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchItems = async () => {
        setLoading(true);

        try {
            const localQueue = await getQueue();

            let serverLogs = [];
            try {
                const token = localStorage.getItem('token');
                const logs = await getLogs(token);
                serverLogs = logs.map((log) => ({
                    ...log,
                    id: log.id,
                    status: 'synced',
                    label: log.event_id
                }));
            } catch {
                console.log('Could not fetch server logs, showing local only');
            }

            const merged = [...localQueue, ...serverLogs]
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            setItems(merged);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchItems();
    }, []);

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
            <div className="p-4 flex items-center justify-between bg-white dark:bg-gray-800 shadow-sm">
                <div className="flex items-center gap-4">
                    <button onClick={() => window.history.back()} className="p-2 -ml-2 text-gray-600"><ArrowLeft /></button>
                    <h1 className="font-bold text-gray-900 dark:text-white">Update History</h1>
                </div>
                <button onClick={fetchItems} className="p-2 text-primary-500"><RefreshCw size={20} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {loading ? (
                    <div className="text-center p-8 text-gray-500 text-sm">Loading records...</div>
                ) : items.length === 0 ? (
                    <div className="text-center p-12 text-gray-400">
                        <Clock className="mx-auto mb-2 opacity-20" size={48} />
                        <p>No recent updates found</p>
                    </div>
                ) : (
                    items.map((item, idx) => (
                        <div key={idx} className="p-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
                            <div className="flex justify-between items-start mb-2">
                                <div>
                                    <p className="text-xs font-mono text-gray-500">{item.awb}</p>
                                    <h3 className="font-bold text-gray-900 dark:text-white">{item.event_id || item.label}</h3>
                                </div>
                                {item.status === 'synced' ? (
                                    <div className="flex items-center gap-1 text-green-500 text-xs font-bold">
                                        <CheckCircle size={14} /> Synced
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-1 text-blue-500 text-xs font-bold">
                                        <Clock size={14} /> Pending
                                    </div>
                                )}
                            </div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-tighter">
                                {new Date(item.timestamp).toLocaleString()}
                            </p>
                            {item.error_message && (
                                <p className="mt-2 text-xs text-red-500 flex items-center gap-1">
                                    <AlertCircle size={12} /> {item.error_message}
                                </p>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
