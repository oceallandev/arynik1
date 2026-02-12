import { useNavigate } from 'react-router-dom';
import Scanner from '../components/Scanner';
import StatusSelect from './StatusSelect';
import { syncQueue } from '../store/queue';
import { useAuth } from '../context/AuthContext';

export default function Home() {
    const [showScanner, setShowScanner] = useState(false);
    const [currentAwb, setCurrentAwb] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);
    const navigate = useNavigate();
    const { user } = useAuth();

    useEffect(() => {
        // Attempt sync on home mount
        const token = localStorage.getItem('token');
        if (token) syncQueue(token);
    }, []);

    const handleScan = (awb) => {
        setCurrentAwb(awb);
        setShowScanner(false);
    };

    const handleUpdateComplete = (outcome) => {
        setLastUpdate({ awb: currentAwb, outcome });
        setCurrentAwb(null);
        // Reset notification after 3s
        setTimeout(() => setLastUpdate(null), 3000);
    };

    if (currentAwb) {
        return <StatusSelect
            awb={currentAwb}
            onBack={() => setCurrentAwb(null)}
            onComplete={handleUpdateComplete}
        />;
    }

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
            <header className="p-6 bg-white dark:bg-gray-800 shadow-sm flex justify-between items-center bg-gradient-to-r from-white to-gray-50 dark:from-gray-800 dark:to-gray-900">
                <div className="flex items-center gap-3">
                    <img src="/logo-horizontal.png" alt="AWB System" className="h-10 object-contain" />
                    <div className="flex items-center gap-1 text-[10px] text-green-500 font-extrabold uppercase tracking-widest bg-green-50 px-2 py-0.5 rounded-full">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                        Live
                    </div>
                </div>
                <div className="p-2 rounded-full bg-gray-100 dark:bg-gray-700 shadow-inner">
                    <Smartphone size={18} className="text-gray-400" />
                </div>
            </header>

            <main className="flex-1 p-6 space-y-6">
                {lastUpdate && (
                    <div className={`p-4 rounded-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 ${lastUpdate.outcome === 'SUCCESS' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                        }`}>
                        <CheckCircle size={20} />
                        <div>
                            <span className="font-bold">Update {lastUpdate.outcome === 'SUCCESS' ? 'Confirmed' : 'Queued'}</span>
                            <p className="text-xs opacity-75">{lastUpdate.awb}</p>
                        </div>
                    </div>
                )}

                <button
                    onClick={() => setShowScanner(true)}
                    className="w-full h-48 bg-primary-600 rounded-3xl shadow-2xl shadow-primary-500/30 flex flex-col items-center justify-center text-white space-y-4 active:scale-95 transition-transform"
                >
                    <div className="p-4 bg-white/20 rounded-full">
                        <Package size={48} />
                    </div>
                    <div className="text-center">
                        <h2 className="text-xl font-bold">New Scan</h2>
                        <p className="text-primary-100 text-sm">Scan Shipment AWB</p>
                    </div>
                </button>

                {(user?.role === 'Manager' || user?.role === 'Admin') && (
                    <button
                        onClick={() => navigate('/shipments')}
                        className="w-full p-6 bg-white dark:bg-gray-800 rounded-3xl shadow-sm flex items-center gap-4 text-left active:scale-[0.98] transition-all"
                    >
                        <div className="p-3 bg-blue-50 text-blue-500 rounded-xl">
                            <Search size={24} />
                        </div>
                        <div className="flex-1">
                            <h3 className="font-bold text-gray-900 dark:text-white">Search Shipments</h3>
                            <p className="text-xs text-gray-500">View and track all shipments</p>
                        </div>
                        <ChevronRight className="text-gray-300" />
                    </button>
                )}

                <div className="grid grid-cols-2 gap-4">
                    <button
                        onClick={() => navigate('/history')}
                        className="p-6 bg-white dark:bg-gray-800 rounded-3xl shadow-sm space-y-2 text-left"
                    >
                        <div className="p-2 w-fit bg-primary-50 text-primary-500 rounded-lg"><History size={24} /></div>
                        <h3 className="font-bold text-gray-900 dark:text-white">History</h3>
                        <p className="text-xs text-gray-500 underline">View logs</p>
                    </button>
                    <button
                        onClick={() => navigate('/settings')}
                        className="p-6 bg-white dark:bg-gray-800 rounded-3xl shadow-sm space-y-2 text-left"
                    >
                        <div className="p-2 w-fit bg-gray-50 text-gray-500 rounded-lg"><Settings size={24} /></div>
                        <h3 className="font-bold text-gray-900 dark:text-white">Settings</h3>
                        <p className="text-xs text-gray-500 underline">Profile</p>
                    </button>
                </div>
            </main>

            {showScanner && <Scanner onScan={handleScan} onClose={() => setShowScanner(false)} />}
        </div>
    );
}
