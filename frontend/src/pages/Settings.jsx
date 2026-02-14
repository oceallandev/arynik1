import React from 'react';
import { Info, LogOut, ShieldCheck, User, Bell, Globe, Moon, Sun, ChevronRight, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate('/login', { replace: true });
    };

    const settingsSections = [
        {
            title: 'Preferences',
            items: [
                { icon: Bell, label: 'Notifications', value: 'Enabled', color: 'violet' },
                { icon: Globe, label: 'Language', value: 'English', color: 'emerald' },
                { icon: Moon, label: 'Dark Mode', value: 'Auto', color: 'amber' }
            ]
        },
        {
            title: 'Account',
            items: [
                { icon: ShieldCheck, label: 'Security', value: null, color: 'violet' },
                { icon: Info, label: 'App Info', value: 'v1.0.0', color: 'slate' }
            ]
        }
    ];

    const getIconBg = (color) => {
        const colors = {
            violet: 'bg-violet-500/20',
            emerald: 'bg-emerald-500/20',
            amber: 'bg-amber-500/20',
            slate: 'bg-slate-500/20'
        };
        return colors[color] || colors.slate;
    };

    const getIconColor = (color) => {
        const colors = {
            violet: 'text-violet-400',
            emerald: 'text-emerald-400',
            amber: 'text-amber-400',
            slate: 'text-slate-400'
        };
        return colors[color] || colors.slate;
    };

    return (
        <div className="min-h-screen flex flex-col relative overflow-hidden">
            {/* Background Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Profile Header with Gradient */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-violet-600 via-purple-600 to-violet-700"></div>
                <div className="absolute inset-0 shimmer opacity-20"></div>

                <header className="relative z-10 px-6 pt-6 pb-4">
                    <h1 className="text-xl font-black text-white uppercase tracking-tight mb-1">Settings</h1>
                    <p className="text-sm text-violet-100 font-medium">Manage your preferences</p>
                </header>

                <div className="relative z-10 px-8 pb-8 flex flex-col items-center">
                    <div className="w-28 h-28 bg-gradient-to-br from-white/20 to-white/10 backdrop-blur-xl rounded-[32px] shadow-2xl flex items-center justify-center text-white mb-5 border-4 border-white/30 animate-float">
                        <User size={56} strokeWidth={1.5} />
                    </div>
                    <h2 className="text-2xl font-black text-white uppercase tracking-tight mb-2">
                        {user?.username || 'Driver'}
                    </h2>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black bg-white/20 backdrop-blur-sm text-white px-3 py-1.5 rounded-full uppercase tracking-widest border border-white/30">
                            {user?.role || 'Carrier'}
                        </span>
                        <span className="text-[10px] font-bold text-violet-200 uppercase tracking-widest">
                            ID: {user?.driver_id || 'N/A'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Settings Content */}
            <div className="flex-1 p-4 space-y-6 pb-32 relative z-10 -mt-6">
                {settingsSections.map((section, sIdx) => (
                    <div key={sIdx} className="space-y-3 animate-scale-in" style={{ animationDelay: `${sIdx * 0.1}s` }}>
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {section.title}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent">
                            {section.items.map((item, iIdx) => {
                                const Icon = item.icon;
                                return (
                                    <button
                                        key={iIdx}
                                        className={`w-full p-4 flex items-center gap-4 hover:bg-white/5 transition-all group ${iIdx < section.items.length - 1 ? 'border-b border-white/5' : ''
                                            }`}
                                    >
                                        <div className={`p-3 ${getIconBg(item.color)} rounded-xl group-hover:scale-110 transition-transform`}>
                                            <Icon className={getIconColor(item.color)} size={20} strokeWidth={2} />
                                        </div>
                                        <span className="flex-1 text-left font-bold text-white">{item.label}</span>
                                        {item.value && (
                                            <span className="text-xs text-slate-400 font-medium">{item.value}</span>
                                        )}
                                        <ChevronRight className="text-slate-500 group-hover:text-violet-400 group-hover:translate-x-1 transition-all" size={18} />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}

                {/* Premium Feature Card */}
                <div className="glass-strong p-5 rounded-2xl border-iridescent relative overflow-hidden group animate-scale-in" style={{ animationDelay: '0.2s' }}>
                    <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-amber-600/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10 flex items-center gap-4">
                        <div className="p-3 bg-gradient-to-br from-amber-500 to-amber-600 rounded-xl shadow-glow-sm">
                            <Sparkles size={24} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <h3 className="font-black text-white text-sm">Premium Features</h3>
                            <p className="text-[10px] text-slate-400 font-medium mt-1">
                                Unlock advanced analytics & insights
                            </p>
                        </div>
                        <ChevronRight className="text-amber-400" size={20} />
                    </div>
                </div>

                {/* Logout Button */}
                <button
                    onClick={handleLogout}
                    className="w-full btn-premium py-4 bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-400 hover:to-rose-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-glow-md transition-all animate-scale-in"
                    style={{ animationDelay: '0.3s' }}
                >
                    <LogOut size={20} strokeWidth={2.5} />
                    Sign Out
                </button>
            </div>

            {/* Footer */}
            <div className="p-6 text-center relative z-10">
                <p className="text-[10px] text-slate-500 font-medium">Powered by Postis Bridge</p>
                <p className="text-[9px] text-slate-600 font-medium mt-1">© 2025 AryNik Driver App</p>
            </div>
        </div>
    );
}
