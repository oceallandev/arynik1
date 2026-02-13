import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, History, Calendar, Settings } from 'lucide-react';

export default function BottomNav() {
    const navigate = useNavigate();
    const location = useLocation();

    const tabs = [
        { path: '/', icon: Home, label: 'Home' },
        { path: '/history', icon: History, label: 'History' },
        { path: '/calendar', icon: Calendar, label: 'Calendar' },
        { path: '/settings', icon: Settings, label: 'Settings' }
    ];

    return (
        <nav className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border-t border-gray-100 dark:border-gray-700 pb-safe z-50">
            <div className="flex justify-around items-center h-16 max-w-lg mx-auto">
                {tabs.map((tab) => {
                    const active = location.pathname === tab.path;
                    return (
                        <button
                            key={tab.path}
                            onClick={() => navigate(tab.path)}
                            className={`flex flex-col items-center justify-center w-full transition-all duration-300 ${active ? 'text-primary-600 scale-110' : 'text-gray-400'
                                }`}
                        >
                            <tab.icon size={22} className={active ? 'stroke-[2.5px]' : ''} />
                            <span className={`text-[10px] mt-1 font-bold uppercase tracking-tighter ${active ? 'opacity-100' : 'opacity-0'
                                }`}>
                                {tab.label}
                            </span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
