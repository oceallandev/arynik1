import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Loader2, MessageCircle, RefreshCw, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ensureChatThread, listChatThreads } from '../services/api';

const fmtDateTime = (iso) => {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return '';
    }
};

export default function ChatInbox() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [awb, setAwb] = useState('');
    const [busyOpen, setBusyOpen] = useState(false);

    const unreadTotal = useMemo(() => {
        return (Array.isArray(threads) ? threads : []).reduce((acc, t) => acc + (Number(t?.unread_count) || 0), 0);
    }, [threads]);

    const refresh = async () => {
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

    useEffect(() => {
        refresh();
        if (!token) return;
        const id = setInterval(() => refresh(), 15000);
        return () => clearInterval(id);
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
                setError('Failed to open chat');
            }
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to open chat'));
        } finally {
            setBusyOpen(false);
        }
    };

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
                        {unreadTotal} unread
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
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                <div className="glass-strong p-4 rounded-3xl border border-white/10 space-y-3">
                    <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Open chat by AWB</div>
                    <div className="flex items-center gap-2">
                        <div className="flex-1 flex items-center gap-2 glass-light rounded-2xl border border-white/10 px-3 py-3">
                            <Search size={16} className="text-slate-500" />
                            <input
                                value={awb}
                                onChange={(e) => setAwb(e.target.value)}
                                placeholder="Enter AWB (e.g. AWB123...)"
                                className="w-full bg-transparent outline-none text-sm font-bold text-white placeholder:text-slate-600"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={openByAwb}
                            disabled={busyOpen}
                            className={`w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all flex items-center justify-center ${busyOpen ? 'opacity-60 cursor-not-allowed' : ''}`}
                            title="Open"
                        >
                            {busyOpen ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}
                        </button>
                    </div>
                    <div className="text-[11px] font-bold text-slate-400">
                        Tip: recipients can also open chat from the shipment details screen, then pin the delivery location.
                    </div>
                </div>

                {loading ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 flex items-center gap-3 text-slate-300">
                        <Loader2 className="animate-spin" size={18} />
                        <span className="text-sm font-bold">Loading...</span>
                    </div>
                ) : null}

                {!loading && (!threads || threads.length === 0) ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <MessageCircle className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No conversations yet</p>
                        <p className="text-sm mt-2 text-slate-500">Open a chat by AWB to start messaging</p>
                    </div>
                ) : null}

                {!loading && Array.isArray(threads) ? (
                    threads.map((t) => {
                        const unread = Number(t?.unread_count) || 0;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => navigate(`/chat/${encodeURIComponent(String(t.id))}`)}
                                className="w-full text-left glass-strong p-5 rounded-3xl border border-white/10 hover:bg-white/5 transition-all"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-black text-white truncate">
                                            {t?.awb ? String(t.awb).toUpperCase() : (t?.subject || 'Chat')}
                                        </p>
                                        <p className="text-xs text-slate-300 font-medium mt-1 break-words">
                                            {String(t?.last_message_preview || 'No messages yet')}
                                        </p>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2">
                                            {t?.last_message_at ? `Last: ${fmtDateTime(t.last_message_at)}` : (t?.created_at ? `Created: ${fmtDateTime(t.created_at)}` : '')}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {unread > 0 ? (
                                            <div className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest">
                                                {unread}
                                            </div>
                                        ) : null}
                                        <div className="w-10 h-10 rounded-2xl glass-light border border-white/10 flex items-center justify-center text-slate-400">
                                            <ArrowRight size={18} />
                                        </div>
                                    </div>
                                </div>
                            </button>
                        );
                    })
                ) : null}
            </main>
        </motion.div>
    );
}

