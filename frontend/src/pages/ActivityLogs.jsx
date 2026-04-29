import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getActivityLogs } from '../services/api';

export default function ActivityLogs() {
    const { user } = useAuth();
    const token = user?.token;
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [userQuery, setUserQuery] = useState('');

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            loadLogs();
        }, 500); // Debounce search
        return () => clearTimeout(timeoutId);
    }, [token, userQuery]);

    const loadLogs = async () => {
        try {
            setLoading(true);
            const data = await getActivityLogs(token, 200, userQuery);
            setLogs(data);
            setError(null);
        } catch (err) {
            console.error('Failed to load activity logs:', err);
            setError('Nu s-au putut încărca logurile de operațiuni.');
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return <div className="p-6 text-center text-slate-400">Încărcare date...</div>;
    }

    if (error) {
        return <div className="p-6 text-center text-red-500">{error}</div>;
    }

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                    Jurnal Operațiuni
                </h1>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <input
                        type="text"
                        placeholder="Caută utilizator..."
                        value={userQuery}
                        onChange={(e) => setUserQuery(e.target.value)}
                        className="w-full sm:w-64 bg-[#1a1c24] text-white border border-white/[0.1] rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                    <button
                        onClick={loadLogs}
                        className="px-4 py-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors text-sm font-medium whitespace-nowrap"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            <div className="bg-[#12141c] border border-white/[0.05] rounded-xl overflow-hidden shadow-2xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-[#1a1c24] border-b border-white/[0.05]">
                            <tr>
                                <th className="px-6 py-4 font-medium text-slate-300">Timp</th>
                                <th className="px-6 py-4 font-medium text-slate-300">Utilizator</th>
                                <th className="px-6 py-4 font-medium text-slate-300">Tip</th>
                                <th className="px-6 py-4 font-medium text-slate-300">Acțiune / Path</th>
                                <th className="px-6 py-4 font-medium text-slate-300">Locație GPS</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.02]">
                            {logs.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="px-6 py-8 text-center text-slate-500">
                                        Nu există înregistrări recente.
                                    </td>
                                </tr>
                            ) : (
                                logs.map((log) => (
                                    <tr key={log.id} className="hover:bg-white/[0.02] transition-colors group">
                                        <td className="px-6 py-4 text-slate-400">
                                            {new Date(log.timestamp).toLocaleString("ro-RO")}
                                        </td>
                                        <td className="px-6 py-4 font-medium text-slate-300">
                                            {log.user_name || log.user_id}
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold ${
                                                log.action_type === 'MODIFY' 
                                                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' 
                                                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                            }`}>
                                                {log.action_type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col gap-1">
                                                <span className="text-indigo-300 font-mono text-xs">
                                                    {log.method || 'GET'} {log.path}
                                                </span>
                                                {log.details && (
                                                    <span className="text-slate-500 text-xs truncate max-w-sm">
                                                        {log.details}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            {log.latitude && log.longitude ? (
                                                <a 
                                                    href={`https://maps.google.com/?q=${log.latitude},${log.longitude}`} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300 transition-colors"
                                                >
                                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                                                    Vezi Harta
                                                </a>
                                            ) : (
                                                <span className="text-slate-600 text-xs italic">Indisponibil</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
