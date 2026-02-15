import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, PackageSearch, Phone, Lock, User, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { recipientSignup } from '../services/api';

export default function RecipientSignup() {
    const navigate = useNavigate();
    const { login } = useAuth();

    const [awb, setAwb] = useState('');
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
            const data = await recipientSignup({
                awb: String(awb || '').trim(),
                phone: String(phone || '').trim(),
                password: String(password || ''),
                name: String(name || '').trim() || undefined
            });

            if (data?.access_token) {
                await login(data.access_token, data.role);
                navigate('/shipments', { replace: true });
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (err) {
            setError(err?.response?.data?.detail || err?.message || 'Failed to create account');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-screen relative overflow-hidden flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-600/15 via-slate-950 to-violet-600/10"></div>
            <div className="absolute top-10 left-10 w-72 h-72 bg-emerald-500/20 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-20 right-10 w-80 h-80 bg-violet-500/15 rounded-full blur-3xl animate-float" style={{ animationDelay: '3s' }}></div>

            <div className="relative z-10 w-full max-w-md">
                <button
                    type="button"
                    onClick={() => navigate('/login')}
                    className="mb-4 inline-flex items-center gap-2 text-slate-300 hover:text-white text-xs font-black uppercase tracking-widest"
                >
                    <ArrowLeft size={16} />
                    Back to login
                </button>

                <div className="glass-strong rounded-3xl p-8 border-iridescent space-y-6 relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none"></div>

                    <div className="text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-emerald-500 to-emerald-700 rounded-3xl shadow-glow-md mb-4">
                            <PackageSearch className="w-8 h-8 text-white" />
                        </div>
                        <h1 className="text-2xl font-black text-white tracking-tight">Track Your Delivery</h1>
                        <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mt-2">Create an account using your AWB</p>
                    </div>

                    <form onSubmit={submit} className="space-y-4 relative">
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                                <PackageSearch size={14} className="text-emerald-400" />
                                AWB
                            </label>
                            <input
                                value={awb}
                                onChange={(e) => setAwb(e.target.value)}
                                className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 font-mono"
                                placeholder="e.g. AWB1234567"
                                required
                                autoFocus
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                                <Phone size={14} className="text-emerald-400" />
                                WhatsApp Number
                            </label>
                            <input
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300"
                                placeholder="+40 712 345 678"
                                required
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                                <Lock size={14} className="text-emerald-400" />
                                Password
                            </label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300"
                                placeholder="Choose a password"
                                required
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                                <User size={14} className="text-emerald-400" />
                                Name (Optional)
                            </label>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300"
                                placeholder="Your name"
                            />
                        </div>

                        {error && (
                            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-xl text-sm font-medium">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={busy}
                            className="btn-premium w-full py-4 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-glow-md hover:shadow-glow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 text-sm uppercase tracking-wider"
                        >
                            {busy ? (
                                <>
                                    <Loader2 className="animate-spin" size={20} />
                                    Creating...
                                </>
                            ) : (
                                'Create Account'
                            )}
                        </button>
                    </form>

                    <p className="text-center text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                        Already have an account? Use your phone number as username on the login screen.
                    </p>
                </div>
            </div>
        </div>
    );
}

