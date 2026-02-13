import React, { useEffect, useState } from 'react';
import { CheckCircle, ChevronRight, Package, Search, Smartphone } from 'lucide-react';
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
    const navigate = useNavigate();
    const { user } = useAuth();
    const logoUrl = `${import.meta.env.BASE_URL}logo-horizontal.png`;

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (token) {
            syncQueue(token);
        }
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
        <div className="flex flex-col min-h-screen">
            <header className="p-6 bg-white dark:bg-gray-800 shadow-sm flex justify-between items-center bg-gradient-to-r from-white to-gray-50 dark:from-gray-800 dark:to-gray-900 sticky top-0 z-10">
                <div className="flex items-center gap-3">
                    <img src={logoUrl} alt="AWB System" className="h-10 object-contain" />
                    <div className="flex items-center gap-1 text-[10px] text-green-500 font-extrabold uppercase tracking-widest bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                        Live
                    </div>
                </div>
                <div className="p-2 rounded-full bg-gray-100 dark:bg-gray-700 shadow-inner">
                    <Smartphone size={18} className="text-gray-400" />
                </div>
            </header>

            <main className="flex-1 p-6 space-y-8">
                <StatsBanner />

                {lastUpdate && (
                    <div className={`p-4 rounded-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 ${lastUpdate.outcome === 'SUCCESS'
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
                        }`}>
                        <CheckCircle size={20} />
                        <div>
                            <span className="font-bold">Update {lastUpdate.outcome === 'SUCCESS' ? 'Confirmed' : 'Queued'}</span>
                            <p className="text-xs opacity-75">{lastUpdate.awb}</p>
                        </div>
                    </div>
                )}

                <div className="space-y-4">
                    <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] ml-1">Operations</h3>
                    <button
                        onClick={() => setShowScanner(true)}
                        className="w-full py-12 bg-primary-600 rounded-[32px] shadow-2xl shadow-primary-500/30 flex flex-col items-center justify-center text-white space-y-4 active:scale-95 transition-all"
                    >
                        <div className="p-5 bg-white/20 rounded-full">
                            <Package size={42} />
                        </div>
                        <div className="text-center">
                            <h2 className="text-xl font-black uppercase tracking-tight">New Scan</h2>
                            <p className="text-primary-100 text-xs font-bold opacity-80 uppercase tracking-widest">Tap to start scanner</p>
                        </div>
                    </button>

                    {(user?.role === 'Manager' || user?.role === 'Admin') && (
                        <button
                            onClick={() => navigate('/shipments')}
                            className="w-full p-6 bg-white dark:bg-gray-800 rounded-[32px] shadow-sm flex items-center gap-4 text-left active:bg-gray-50 dark:active:bg-gray-700/50 transition-all border border-gray-100 dark:border-gray-700"
                        >
                            <div className="p-4 bg-primary-50 dark:bg-primary-900/20 text-primary-600 rounded-2xl">
                                <Search size={24} />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-bold text-gray-900 dark:text-white uppercase text-sm tracking-tight">Live Tracker</h3>
                                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Search & Batch Fetch</p>
                            </div>
                            <ChevronRight className="text-gray-300" />
                        </button>
                    )}
                </div>
            </main>

            {showScanner && <Scanner onScan={handleScan} onClose={() => setShowScanner(false)} />}
        </div>
    );
}
