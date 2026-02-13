import React from 'react';
import { Info, LogOut, ShieldCheck, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate('/login', { replace: true });
    };

    return (
        <div className="min-h-screen flex flex-col">
            <header className="p-6 bg-white dark:bg-gray-800 shadow-sm flex items-center gap-4 sticky top-0 z-10">
                <h1 className="text-xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Profile Settings</h1>
            </header>

            <div className="p-8 flex flex-col items-center bg-gradient-to-b from-white to-gray-50 dark:from-gray-800 dark:to-gray-900">
                <div className="w-28 h-28 bg-primary-600 rounded-[40px] shadow-2xl shadow-primary-500/30 flex items-center justify-center text-white mb-6 border-4 border-white dark:border-gray-700">
                    <User size={56} className="opacity-90" />
                </div>
                <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tighter">{user?.username || 'Driver'}</h2>
                <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-black bg-primary-50 dark:bg-primary-900/40 text-primary-600 px-3 py-1 rounded-full uppercase tracking-widest">{user?.role || 'Carrier'}</span>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">ID: {user?.driver_id || 'N/A'}</span>
                </div>
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
