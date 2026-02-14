import React, { useEffect, useState } from 'react';
import { CheckCircle, ChevronRight, Package, Search, Smartphone, ScanLine, Zap, TrendingUp, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import StatsBanner from '../components/StatsBanner';
import Scanner from '../components/Scanner';
import { useAuth } from '../context/AuthContext';
import StatusSelect from './StatusSelect';
import { syncQueue } from '../store/queue';

export default function Home() {
    const [showScanner, setShowScanner] = useState(false);
    const [currentAwb, setCurrentAwb] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [greeting, setGreeting] = useState('');
    const navigate = useNavigate();
    const { user } = useAuth();

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (token) {
            syncQueue(token);
        }

        // Dynamic greeting based on time
        const hour = new Date().getHours();
        if (hour < 12) setGreeting('Good Morning');
        else if (hour < 18) setGreeting('Good Afternoon');
        else setGreeting('Good Evening');
    }, []);

    const handleScan = (awb) => {
        setCurrentAwb(awb);
        setShowScanner(false);
    };

    const handleUpdateComplete = (outcome) => {
        setLastUpdate({ awb: currentAwb, outcome });
        setCurrentAwb(null);
        setTimeout(() => setLastUpdate(null), 3000);
    };

    if (currentAwb) {
        return (
            <StatusSelect
                awb={currentAwb}
                onBack={() => setCurrentAwb(null)}
                onComplete={handleUpdateComplete}
            />
        );
    }

    return (
        <div className="flex flex-col min-h-screen relative overflow-hidden">
            {/* Background Gradient Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '0s' }}></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '3s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-glow-md animate-float">
                        <span className="text-white font-black italic tracking-tighter text-xl">AN</span>
                    </div>
                    <div>
                        <h1 className="text-lg font-black text-gradient leading-none">AryNik</h1>
                        <div className="flex items-center gap-1.5 mt-1">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Online</span>
                        </div>
                    </div>
                </div>
                <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center border border-white/10">
                    <Smartphone size={18} className="text-violet-400" />
                </div>
            </header>

            <main className="flex-1 p-6 space-y-8 pb-32 relative z-10">
                {/* Greeting */}
                <div className="animate-slide-up">
                    <h2 className="text-3xl font-black text-white mb-1">{greeting}</h2>
                    <p className="text-slate-400 font-medium">{user?.name || 'Driver'} • Ready to deliver excellence</p>
                </div>

                <StatsBanner />

                {lastUpdate && (
                    <div className={`p-4 rounded-2xl flex items-center gap-4 animate-slide-up shadow-lg ${lastUpdate.outcome === 'SUCCESS'
                        ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-emerald-500/20'
                        : 'bg-gradient-to-r from-violet-500 to-purple-600 shadow-violet-500/20'
                        }`}>
                        <div className="p-2 bg-white/20 rounded-xl backdrop-blur-sm">
                            <CheckCircle size={20} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <span className="font-black text-sm uppercase tracking-wide text-white">Update {lastUpdate.outcome === 'SUCCESS' ? 'Confirmed' : 'Queued'}</span>
                            <p className="text-xs font-bold text-white/80">{lastUpdate.awb}</p>
                        </div>
                    </div>
                )}

                <div className="space-y-4">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Quick Actions</h3>

                    {/* Primary Action: Scan AWB */}
                    <button
                        onClick={() => setShowScanner(true)}
                        className="card-hover w-full py-12 bg-gradient-to-br from-violet-600 via-purple-600 to-violet-700 rounded-[32px] shadow-glow-lg flex flex-col items-center justify-center text-white space-y-5 active:scale-[0.98] transition-all relative overflow-hidden group"
                    >
                        <div className="absolute inset-0 shimmer opacity-30"></div>
                        <div className="absolute top-0 right-0 w-40 h-40 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16"></div>
                        <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/10 rounded-full blur-3xl -ml-12 -mb-12"></div>

                        <div className="p-6 bg-white/10 rounded-3xl backdrop-blur-sm border border-white/20 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 shadow-inner-glow">
                            <ScanLine size={52} strokeWidth={1.5} className="animate-glow" />
                        </div>
                        <div className="text-center relative z-10">
                            <h2 className="text-2xl font-black uppercase tracking-tight">Scan Package</h2>
                            <p className="text-violet-100 text-xs font-bold opacity-90 uppercase tracking-widest mt-1 flex items-center justify-center gap-2">
                                <Zap size={12} />
                                Tap to open scanner
                            </p>
                        </div>
                    </button>

                    {/* Secondary Actions */}
                    {(user?.role === 'Manager' || user?.role === 'Admin') && (
                        <button
                            onClick={() => navigate('/shipments')}
                            className="card-hover w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left active:scale-[0.99] transition-all group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Search size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    Search Shipments
                                    <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-bold">LIVE</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5 flex items-center gap-1">
                                    <TrendingUp size={10} />
                                    Real-time tracking
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </button>
                    )}

                    {/* Additional Quick Stats Cards */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="glass-strong p-4 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.1s' }}>
                            <div className="flex items-center gap-2 mb-2">
                                <div className="p-2 bg-amber-500/20 rounded-lg">
                                    <Clock size={16} className="text-amber-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Pending</span>
                            </div>
                            <p className="text-2xl font-black text-gradient-purple">--</p>
                        </div>

                        <div className="glass-strong p-4 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.2s' }}>
                            <div className="flex items-center gap-2 mb-2">
                                <div className="p-2 bg-emerald-500/20 rounded-lg">
                                    <Package size={16} className="text-emerald-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Today</span>
                            </div>
                            <p className="text-2xl font-black text-gradient-blue">--</p>
                        </div>
                    </div>
                </div>
            </main>

            {showScanner && <Scanner onScan={handleScan} onClose={() => setShowScanner(false)} />}
        </div>
    );
}
