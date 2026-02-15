import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getNotifications, markNotificationRead } from '../services/api';

export default function ChatNotificationListener() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [notif, setNotif] = useState(null);
    const seenRef = useRef(new Set());

    useEffect(() => {
        if (!token) return;

        let cancelled = false;
        const poll = async () => {
            try {
                const items = await getNotifications(token, { limit: 50, unread_only: true }).catch(() => []);
                const list = Array.isArray(items) ? items : [];
                const chat = list
                    .filter((n) => String(n?.data?.type || '') === 'chat_message')
                    .sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0));

                for (const n of chat) {
                    const id = String(n?.id || '');
                    if (!id) continue;
                    if (seenRef.current.has(id)) continue;
                    seenRef.current.add(id);
                    if (!cancelled) {
                        setNotif(n);
                    }
                    break;
                }
            } catch {
                // Ignore transient failures.
            }
        };

        poll();
        const id = setInterval(poll, 12000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [token]);

    const dismiss = async () => {
        const id = notif?.id;
        setNotif(null);
        if (!id || !token) return;
        try {
            await markNotificationRead(token, id);
        } catch { }
    };

    const open = async () => {
        const threadId = notif?.data?.thread_id;
        const id = notif?.id;
        setNotif(null);
        if (id && token) {
            try {
                await markNotificationRead(token, id);
            } catch { }
        }
        if (threadId) {
            navigate(`/chat/${encodeURIComponent(String(threadId))}`);
        }
    };

    if (!notif) return null;

    const body = String(notif?.body || '').trim();
    const awb = notif?.awb ? String(notif.awb).toUpperCase() : null;

    return (
        <div className="fixed bottom-[calc(9rem+env(safe-area-inset-bottom))] left-0 right-0 z-[69] px-4">
            <div className="max-w-xl mx-auto">
                <div className="glass-strong rounded-3xl border-iridescent p-4 shadow-2xl flex items-start gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
                        <MessageCircle size={18} className="text-violet-200" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-black text-white truncate">
                            New chat message{awb ? ` • ${awb}` : ''}
                        </div>
                        {body ? (
                            <div className="text-[11px] font-bold text-slate-300 mt-1 break-words">
                                {body}
                            </div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                            <button
                                type="button"
                                onClick={open}
                                className="px-4 h-10 rounded-2xl border text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all bg-emerald-500/15 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95"
                            >
                                Open
                            </button>
                            <button
                                type="button"
                                onClick={dismiss}
                                className="w-10 h-10 rounded-2xl border flex items-center justify-center transition-all bg-slate-900/40 border-white/10 text-slate-300 hover:bg-white/5 active:scale-95"
                                title="Dismiss"
                            >
                                <X size={18} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

