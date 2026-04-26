import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Loader2, PackageSearch, Send, Sparkles, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { normalizeRole, ROLE_DRIVER, ROLE_MANAGER, ROLE_RECIPIENT } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { askVirtualAssistant } from '../services/api';

const makeMsgId = () => `msg-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const normalizeAwb = (value) => String(value || '').trim().toUpperCase();

export default function Assistant() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang } = useLanguage();
    const role = normalizeRole(user?.role);
    const token = user?.token || localStorage.getItem('token');

    const l = (en, ro) => (lang === 'ro' ? ro : en);

    const welcomeText = useMemo(() => (
        l(
            'I am your Curieru virtual assistant. Ask me about AWB, routes, COD, chat, notifications, manifests, or app usage.',
            'Sunt asistentul virtual Curieru. Intreaba-ma despre AWB, rute, COD, chat, notificari, manifeste sau folosirea aplicatiei.'
        )
    ), [lang]);

    const [messages, setMessages] = useState(() => ([
        { id: makeMsgId(), from: 'assistant', text: welcomeText, provider: 'system', model: null },
    ]));
    const [question, setQuestion] = useState('');
    const [awb, setAwb] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [lastSuggestions, setLastSuggestions] = useState([]);
    const [contextAwbs, setContextAwbs] = useState([]);

    const listRef = useRef(null);

    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, loading]);

    const quickPrompts = useMemo(() => {
        if (role === ROLE_DRIVER) {
            return [
                l('What is my next delivery stop?', 'Care este urmatorul meu stop de livrare?'),
                l('How do I mark a failed delivery?', 'Cum marchez o livrare nereusita?'),
                l('How do I send location in chat?', 'Cum trimit locatia mea in chat?'),
            ];
        }
        if (role === ROLE_RECIPIENT) {
            return [
                l('Where is my shipment right now?', 'Unde este coletul meu acum?'),
                l('How can I reschedule delivery?', 'Cum pot reprograma livrarea?'),
                l('How do I contact support quickly?', 'Cum contactez rapid suportul?'),
            ];
        }
        if (role === ROLE_MANAGER) {
            return [
                l('How do I verify route allocation?', 'Cum verific alocarea unei rute?'),
                l('How do I check COD totals?', 'Cum verific totalurile COD?'),
                l('How do I notify assigned teams?', 'Cum notific echipele alocate?'),
            ];
        }
        return [
            l('How do I check an AWB status?', 'Cum verific statusul unui AWB?'),
            l('How do I open shipment details quickly?', 'Cum deschid rapid detaliile AWB?'),
            l('How do I troubleshoot app errors?', 'Cum diagnostic o eroare in aplicatie?'),
        ];
    }, [lang, role]);

    const ask = async (customQuestion = null) => {
        if (loading) return;
        const q = String(customQuestion ?? question).trim();
        if (!q) return;
        if (!token) {
            setError(l('No active session token.', 'Nu exista sesiune activa.'));
            return;
        }

        setError('');
        const awbContext = normalizeAwb(awb);
        const userMsg = { id: makeMsgId(), from: 'user', text: q };
        setMessages((prev) => [...prev, userMsg]);
        if (customQuestion === null) setQuestion('');
        setLoading(true);

        try {
            const res = await askVirtualAssistant(token, {
                question: q,
                awb: awbContext || undefined,
                context: {
                    source: 'assistant_page',
                    locale: lang,
                    role,
                },
            });

            const answer = String(res?.answer || '').trim() || l('I could not generate an answer.', 'Nu am putut genera un raspuns.');
            const assistantMsg = {
                id: makeMsgId(),
                from: 'assistant',
                text: answer,
                provider: String(res?.provider || '').trim() || null,
                model: String(res?.model || '').trim() || null,
            };
            setMessages((prev) => [...prev, assistantMsg]);
            setLastSuggestions(
                Array.isArray(res?.suggestions)
                    ? res.suggestions.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6)
                    : []
            );
            setContextAwbs(
                Array.isArray(res?.context_awbs)
                    ? res.context_awbs.map((x) => normalizeAwb(x)).filter(Boolean)
                    : []
            );
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            const fallbackText = detail || l('The assistant is unavailable right now.', 'Asistentul nu este disponibil momentan.');
            setError(fallbackText);
            setMessages((prev) => [
                ...prev,
                { id: makeMsgId(), from: 'assistant', text: fallbackText, provider: 'error', model: null },
            ]);
        } finally {
            setLoading(false);
        }
    };

    const resetConversation = () => {
        setMessages([{ id: makeMsgId(), from: 'assistant', text: welcomeText, provider: 'system', model: null }]);
        setQuestion('');
        setError('');
        setLastSuggestions([]);
        setContextAwbs([]);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-8 right-0 w-80 h-80 bg-cyan-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-start sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="min-w-0">
                    <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                        <Bot size={18} className="text-cyan-300" />
                        {l('Virtual Assistant', 'Asistent Virtual')}
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1">
                        {l('Support for clients, drivers, and managers', 'Suport pentru clienti, soferi si manageri')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={resetConversation}
                    className="px-3 py-2 rounded-xl text-[11px] font-black uppercase tracking-wide border border-white/10 bg-slate-900/35 text-slate-200 hover:bg-white/10 transition-all"
                >
                    <span className="inline-flex items-center gap-2">
                        <Trash2 size={13} />
                        {l('Reset', 'Reset')}
                    </span>
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-3 relative z-10">
                <section className="glass-strong rounded-3xl border border-white/10 p-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                        <label className="flex-1 min-w-[180px] text-[10px] font-black uppercase tracking-wider text-slate-400">
                            {l('AWB context (optional)', 'Context AWB (optional)')}
                            <div className="mt-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10">
                                <PackageSearch size={14} className="text-slate-500" />
                                <input
                                    value={awb}
                                    onChange={(e) => setAwb(normalizeAwb(e.target.value))}
                                    placeholder="AWB123456"
                                    className="w-full bg-transparent text-white text-sm outline-none placeholder:text-slate-600"
                                />
                            </div>
                        </label>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {quickPrompts.map((prompt) => (
                            <button
                                key={prompt}
                                type="button"
                                disabled={loading}
                                onClick={() => { void ask(prompt); }}
                                className="px-3 py-2 rounded-xl text-[11px] font-black border border-cyan-500/30 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20 transition-all disabled:opacity-60"
                            >
                                <span className="inline-flex items-center gap-2">
                                    <Sparkles size={13} />
                                    {prompt}
                                </span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="glass-strong rounded-3xl border border-white/10 p-3">
                    <div ref={listRef} className="max-h-[48vh] overflow-y-auto pr-1 space-y-3">
                        {messages.map((msg) => {
                            const isUser = msg.from === 'user';
                            return (
                                <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[90%] rounded-2xl px-3 py-2 border ${isUser
                                        ? 'bg-violet-500/20 border-violet-400/40 text-violet-50'
                                        : 'bg-slate-900/45 border-white/10 text-slate-100'
                                        }`}>
                                        <div className="text-sm whitespace-pre-wrap break-words">{msg.text}</div>
                                        {!isUser && (msg.provider || msg.model) ? (
                                            <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500 font-black">
                                                {(msg.provider || 'assistant')}{msg.model ? ` • ${msg.model}` : ''}
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                        {loading ? (
                            <div className="flex justify-start">
                                <div className="rounded-2xl px-3 py-2 border bg-slate-900/45 border-white/10 text-slate-200 inline-flex items-center gap-2">
                                    <Loader2 size={14} className="animate-spin" />
                                    <span className="text-sm">{l('Generating answer...', 'Generez raspunsul...')}</span>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </section>

                {contextAwbs.length > 0 ? (
                    <section className="glass-light rounded-2xl border border-white/10 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-black mb-2">
                            {l('AWBs found in context', 'AWB-uri gasite in context')}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {contextAwbs.map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    onClick={() => navigate(`/shipments?awb=${encodeURIComponent(item)}`)}
                                    className="px-3 py-1.5 rounded-xl text-[11px] font-black border border-emerald-500/35 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 transition-all"
                                >
                                    {item}
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}

                {lastSuggestions.length > 0 ? (
                    <section className="glass-light rounded-2xl border border-white/10 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-black mb-2">
                            {l('Suggested follow-ups', 'Intrebari recomandate')}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {lastSuggestions.map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    disabled={loading}
                                    onClick={() => { void ask(item); }}
                                    className="px-3 py-1.5 rounded-xl text-[11px] font-black border border-white/15 bg-slate-900/45 text-slate-200 hover:bg-white/10 transition-all disabled:opacity-60"
                                >
                                    {item}
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}

                {error ? (
                    <div className="glass-strong p-3 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                <section className="glass-strong rounded-2xl border border-white/10 p-3">
                    <div className="flex items-end gap-2">
                        <label className="flex-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
                            {l('Your question', 'Intrebarea ta')}
                            <textarea
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                rows={3}
                                placeholder={l('Type your question...', 'Scrie intrebarea...')}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/45 border border-white/10 text-white text-sm outline-none resize-y placeholder:text-slate-600"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        void ask();
                                    }
                                }}
                            />
                        </label>
                        <button
                            type="button"
                            onClick={() => { void ask(); }}
                            disabled={loading || !String(question || '').trim()}
                            className="h-[46px] px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-500 text-white font-black uppercase text-[11px] tracking-wider shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            <span className="inline-flex items-center gap-2">
                                <Send size={14} />
                                {l('Send', 'Trimite')}
                            </span>
                        </button>
                    </div>
                </section>
            </main>
        </motion.div>
    );
}
