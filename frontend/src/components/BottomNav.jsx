import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, Package, History, Settings, Sparkles } from 'lucide-react';

const NavItem = ({ to, icon: Icon, label, isActive }) => (
    <Link
        to={to}
        className={`magnetic flex flex-col items-center justify-center gap-1.5 px-4 py-3 rounded-2xl transition-all duration-300 relative ${isActive
                ? 'text-white'
                : 'text-slate-500 hover:text-slate-300'
            }`}
    >
        {isActive && (
            <>
                <div className="absolute inset-0 bg-gradient-to-r from-violet-600 to-purple-600 rounded-2xl shadow-glow-md animate-scale-in"></div>
                <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-12 h-1 bg-gradient-to-r from-violet-400 to-purple-400 rounded-full blur-sm"></div>
            </>
        )}
        <Icon
            size={22}
            className={`relative z-10 transition-all duration-300 ${isActive ? 'scale-110 animate-glow' : 'scale-100'}`}
            strokeWidth={isActive ? 2.5 : 2}
        />
        <span className={`text-[10px] font-bold uppercase tracking-wide relative z-10 ${isActive ? '' : 'opacity-70'}`}>
            {label}
        </span>
    </Link>
);

export default function BottomNav() {
    const location = useLocation();
    const currentPath = location.pathname;

    const navItems = [
        { to: '/home', icon: Home, label: 'Home' },
        { to: '/shipments', icon: Package, label: 'Track' },
        { to: '/history', icon: History, label: 'History' },
        { to: '/settings', icon: Settings, label: 'Settings' },
    ];

    return (
        <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4 animate-slide-up">
            <div className="glass-strong rounded-[28px] border-iridescent shadow-2xl px-4 py-2 relative overflow-hidden">
                {/* Shimmer effect */}
                <div className="absolute inset-0 shimmer opacity-10 pointer-events-none"></div>

                {/* Gradient glow */}
                <div className="absolute -inset-[2px] bg-gradient-to-r from-violet-500/20 via-purple-500/20 to-violet-500/20 rounded-[28px] blur-xl -z-10 opacity-50"></div>

                <div className="flex justify-around items-center gap-1 relative z-10">
                    {navItems.map((item) => (
                        <NavItem
                            key={item.to}
                            to={item.to}
                            icon={item.icon}
                            label={item.label}
                            isActive={currentPath === item.to || (currentPath === '/' && item.to === '/home')}
                        />
                    ))}
                </div>
            </div>
        </nav>
    );
}
