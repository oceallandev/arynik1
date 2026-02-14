import React from 'react';
import { motion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { Home, Package, History, Settings, MapPinned } from 'lucide-react';

const NavItem = ({ to, icon: Icon, label, isActive }) => (
    <Link
        to={to}
        className={`relative flex flex-col items-center justify-center gap-1.5 px-3 py-3 rounded-2xl transition-all duration-300 ${isActive
            ? 'text-white'
            : 'text-slate-500 hover:text-slate-300'
            }`}
    >
        {isActive && (
            <motion.div
                layoutId="nav-pill"
                className="absolute inset-0 bg-gradient-to-t from-brand-blue/20 to-transparent rounded-2xl border-b-2 border-brand-blue shadow-[0_0_20px_rgba(59,130,246,0.5)]"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
            />
        )}
        <Icon
            size={22}
            className={`relative z-10 transition-all duration-300 ${isActive ? 'scale-110 drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]' : 'scale-100'}`}
            strokeWidth={isActive ? 2.5 : 2}
        />
        <span className={`text-[10px] font-bold uppercase tracking-wide relative z-10 ${isActive ? 'text-white drop-shadow-md' : 'opacity-70'}`}>
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
        { to: '/routes', icon: MapPinned, label: 'Routes' },
        { to: '/history', icon: History, label: 'History' },
        { to: '/settings', icon: Settings, label: 'Settings' },
    ];

    return (
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm px-4">
            <div className="glass-strong rounded-[32px] border-iridescent shadow-2xl px-2 py-2 flex justify-around items-center relative backdrop-blur-2xl">
                {/* Inner Glow */}
                <div className="absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>

                {navItems.map((item) => (
                    <NavItem
                        key={item.to}
                        to={item.to}
                        icon={item.icon}
                        label={item.label}
                        isActive={
                            currentPath === item.to
                            || (item.to !== '/home' && currentPath.startsWith(item.to))
                            || (currentPath === '/' && item.to === '/home')
                        }
                    />
                ))}
            </div>
        </nav>
    );
}
