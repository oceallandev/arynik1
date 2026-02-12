import React from 'react';
import { ArrowLeft, User, LogOut, ShieldCheck, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Settings() {
    const navigate = useNavigate();
    const userName = "Driver Name"; // Mock or get from state

    const handleLogout = () => {
        localStorage.removeItem('token');
        navigate('/login');
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
            <div className="p-4 flex items-center gap-4 bg-white dark:bg-gray-800 shadow-sm">
                <button onClick={() => window.history.back()} className="p-2 -ml-2 text-gray-600"><ArrowLeft /></button>
                <h1 className="font-bold text-gray-900 dark:text-white">Settings</h1>
            </div>

            <div className="p-6 flex flex-col items-center">
                <div className="w-24 h-24 bg-primary-100 rounded-full flex items-center justify-center text-primary-600 mb-4">
                    <User size={48} />
                </div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{userName}</h2>
                <p className="text-sm text-gray-500">ID: DRV-001</p>
            </div>

            <div className="flex-1 p-4 space-y-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl overflow-hidden shadow-sm">
                    <button className="w-full p-4 flex items-center gap-4 border-b border-gray-50 dark:border-gray-700">
                        <ShieldCheck className="text-primary-500" />
                        <span className="flex-1 text-left font-medium">Security</span>
                    </button>
                    <button className="w-full p-4 flex items-center gap-4 border-b border-gray-50 dark:border-gray-700">
                        <Info className="text-gray-400" />
                        <span className="flex-1 text-left font-medium">App Info</span>
                        <span className="text-xs text-gray-400">v1.0.0</span>
                    </button>
                </div>

                <button
                    onClick={handleLogout}
                    className="w-full p-4 bg-red-50 text-red-600 rounded-2xl font-bold flex items-center justify-center gap-2"
                >
                    <LogOut size={20} /> Sign Out
                </button>
            </div>

            <div className="p-8 text-center text-[10px] text-gray-400">
                Powered by Postis Bridge
            </div>
        </div>
    );
}
