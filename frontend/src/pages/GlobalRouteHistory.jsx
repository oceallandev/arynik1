import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Search, Truck, MapPin, Loader2, Calendar, User, Package } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AwbLink from '../components/AwbLink';

export default function GlobalRouteHistory() {
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [error, setError] = useState('');

    const handleSearch = async (e) => {
        if (e) e.preventDefault();
        const q = query.trim();
        if (q.length < 3) {
            setError('Introduceti cel putin 3 caractere');
            return;
        }
        setError('');
        setLoading(true);
        setSearched(true);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/routes/global-history?q=${encodeURIComponent(q)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Căutarea a eșuat');
            const data = await res.json();
            setResults(data);
        } catch (err) {
            console.error(err);
            setError('A aparut o eroare la server.');
        } finally {
            setLoading(false);
        }
    };

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: { staggerChildren: 0.1 }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, scale: 0.98 },
        visible: { opacity: 1, scale: 1 }
    };

    const getStatusColors = (status) => {
        const s = String(status || '').toLowerCase();
        if (s.includes('done') || s.includes('livrat') || s.includes('completed')) return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400';
        if (s.includes('refuz') || s.includes('skipped')) return 'bg-rose-500/15 border-rose-500/30 text-rose-400';
        if (s.includes('depozit') || s.includes('depot')) return 'bg-sky-500/15 border-sky-500/30 text-sky-400';
        return 'bg-amber-500/15 border-amber-500/30 text-amber-400';
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <div className="px-4 py-4 flex items-center justify-between glass-strong sticky top-0 z-30 backdrop-blur-xl border-b border-white/10">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => navigate(-1)}
                        className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <div>
                        <h1 className="font-black text-lg text-gradient tracking-tight">Cautare Rute si Livrari</h1>
                        <p className="text-xs text-slate-500 font-medium mt-0.5">Gaseste instant un colet pe o ruta</p>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-6 relative z-10 flex-1 flex flex-col max-w-4xl mx-auto w-full">
                
                <form onSubmit={handleSearch} className="relative group">
                    <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/20 to-violet-500/20 rounded-2xl blur-xl group-focus-within:opacity-100 opacity-50 transition-opacity"></div>
                    <div className="glass-strong border border-white/10 rounded-2xl p-2 flex items-center gap-2 relative z-10">
                        <div className="p-3 text-indigo-400">
                            <Search size={22} />
                        </div>
                        <input 
                            autoFocus
                            type="text"
                            placeholder="Cauta AWB, Nume Client, etc..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            className="bg-transparent text-white placeholder-slate-500 w-full text-lg outline-none font-medium"
                        />
                        <button 
                            type="submit"
                            disabled={loading || query.length < 3}
                            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-bold uppercase tracking-wider text-xs transition-colors shadow-glow-sm"
                        >
                            {loading ? <Loader2 className="animate-spin w-4 h-4" /> : 'Cauta'}
                        </button>
                    </div>
                    {error && <p className="text-rose-400 text-xs mt-2 px-2">{error}</p>}
                </form>

                <div className="flex-1 mt-4">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-4">
                            <Loader2 size={32} className="animate-spin text-indigo-500" />
                            <p className="text-sm font-bold tracking-widest uppercase">Caut in arhiva de rute...</p>
                        </div>
                    ) : searched && results.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-4">
                            <Truck size={48} className="opacity-20" />
                            <p className="font-medium">Nu am gasit acest AWB pe nicio ruta inregistrata.</p>
                        </div>
                    ) : (
                        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-4">
                            {results.map((r, idx) => (
                                <motion.div key={idx} variants={itemVariants} className="glass-light border border-white/5 rounded-2xl p-5 hover:border-indigo-500/30 transition-colors">
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <Package size={16} className="text-indigo-400" />
                                                <h3 className="font-bold text-lg text-white">
                                                    <AwbLink awb={r.awb} className="hover:text-indigo-300" />
                                                </h3>
                                            </div>
                                            {(r.recipient_name || r.sender_name) && (
                                                <div className="text-xs text-slate-400 font-medium">
                                                    {r.sender_name && <span className="text-slate-300">{r.sender_name}</span>}
                                                    {r.sender_name && r.recipient_name && ' ➔ '}
                                                    {r.recipient_name && <span className="text-slate-300">{r.recipient_name}</span>}
                                                </div>
                                            )}
                                        </div>
                                        <div className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest border ${getStatusColors(r.stop_state)} text-center`}>
                                            {r.stop_state}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        <div className="glass-strong p-3 rounded-xl border border-white/5 flex flex-col justify-center">
                                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                                                <Calendar size={12} /> Data Rutei
                                            </div>
                                            <p className="text-sm text-slate-200 font-medium break-words">
                                                {r.run_started_at ? new Date(r.run_started_at).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                                            </p>
                                        </div>
                                        
                                        <div className="glass-strong p-3 rounded-xl border border-white/5 flex flex-col justify-center">
                                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                                                <User size={12} /> Curier / Ruta
                                            </div>
                                            <p className="text-sm font-bold text-indigo-300 break-words">{r.driver_id}</p>
                                            <p className="text-xs text-slate-400 truncate">{r.route_name}</p>
                                        </div>

                                        <div className="glass-strong p-3 rounded-xl border border-white/5 flex flex-col justify-center">
                                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                                                <Truck size={12} /> Masina Utilizata
                                            </div>
                                            <p className="text-sm text-slate-200 font-medium break-words px-2 py-0.5 bg-slate-800 rounded w-fit border border-slate-700">
                                                {r.truck_plate || '-'}
                                            </p>
                                        </div>

                                        <div className="glass-strong p-3 rounded-xl border border-white/5 flex flex-col justify-center cursor-pointer hover:bg-white/5 transition-colors" 
                                            onClick={() => window.open(`/routes/${r.route_run_id}`, '_blank')}
                                        >
                                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                                                <MapPin size={12} /> Actiune Ruta
                                            </div>
                                            <p className="text-xs text-indigo-400 font-bold underline underline-offset-2">Vezi Cursa Detaliata</p>
                                        </div>
                                    </div>

                                    {r.stop_notes && (
                                        <div className="mt-4 p-3 rounded-xl bg-orange-500/10 border border-orange-500/20 text-orange-200 text-sm">
                                            <span className="font-bold text-orange-400 text-xs uppercase mr-2 tracking-widest">Nota Cursa:</span>
                                            {r.stop_notes}
                                        </div>
                                    )}
                                </motion.div>
                            ))}
                        </motion.div>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
