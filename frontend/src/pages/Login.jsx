import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, User, Lock, Loader2, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleLogin = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            // Import the actual API login service
            const { login: apiLogin } = await import('../services/api');
            const data = await apiLogin(username, password);

            if (data && data.access_token) {
                // Pass the token and role to AuthContext
                await login(data.access_token, data.role);
                navigate('/home');
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (err) {
            console.error('Login error:', err);
            setError(err.response?.data?.detail || err.message || 'Invalid credentials. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative overflow-hidden flex items-center justify-center p-4">
            {/* Aurora Gradient Background */}
            <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-purple-600/10 to-pink-600/20 animate-pulse-slow"></div>
            <div className="absolute inset-0 bg-gradient-to-tr from-blue-600/10 via-transparent to-emerald-600/10"></div>

            {/* Floating Particles */}
            {[...Array(20)].map((_, i) => (
                <div
                    key={i}
                    className="particle"
                    style={{
                        left: `${Math.random() * 100}%`,
                        top: `${Math.random() * 100}%`,
                        animationDelay: `${Math.random() * 8}s`,
                        animationDuration: `${8 + Math.random() * 4}s`,
                    }}
                />
            ))}

            {/* Glow Orbs */}
            <div className="absolute top-10 left-20 w-72 h-72 bg-violet-500/30 rounded-full blur-3xl animate-float" style={{ animationDelay: '0s' }}></div>
            <div className="absolute bottom-20 right-10 w-80 h-80 bg-pink-500/20 rounded-full blur-3xl animate-float" style={{ animationDelay: '4s' }}></div>
            <div className="absolute top-40 right-40 w-60 h-60 bg-blue-500/20 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Login Card */}
            <div className="relative z-10 w-full max-w-md animate-scale-in">
                {/* Logo / Brand */}
                <div className="text-center mb-8 animate-slide-down">
                    <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-violet-500 to-purple-600 rounded-3xl shadow-glow-md mb-4 animate-float">
                        <Sparkles className="w-10 h-10 text-white" />
                    </div>
                    <h1 className="text-4xl font-black text-gradient mb-2 tracking-tight">AryNik Driver</h1>
                    <p className="text-slate-400 text-sm font-medium">Welcome back, let's get started</p>
                </div>

                {/* Login Form */}
                <form onSubmit={handleLogin} className="glass-strong rounded-3xl p-8 border-iridescent space-y-6 relative overflow-hidden">
                    {/* Inner glow effect */}
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none"></div>

                    <div className="relative">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                            <User size={14} className="text-violet-400" />
                            Username
                        </label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 transition-all duration-300"
                            placeholder="Enter your username"
                            required
                            autoFocus
                        />
                    </div>

                    <div className="relative">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                            <Lock size={14} className="text-violet-400" />
                            Password
                        </label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 transition-all duration-300"
                            placeholder="Enter your password"
                            required
                        />
                    </div>

                    {error && (
                        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-xl text-sm font-medium animate-slide-down">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn-premium w-full py-4 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-glow-md hover:shadow-glow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 text-sm uppercase tracking-wider magnetic"
                    >
                        {loading ? (
                            <>
                                <Loader2 className="animate-spin" size={20} />
                                Authenticating...
                            </>
                        ) : (
                            <>
                                <LogIn size={20} />
                                Login to Dashboard
                            </>
                        )}
                    </button>

                    <p className="text-center text-xs text-slate-500 mt-4">
                        Demo: <span className="text-violet-400 font-mono">demo / demo</span>
                    </p>
                </form>

                {/* Footer */}
                <p className="text-center text-xs text-slate-600 mt-6">
                    Secure driver authentication • AryNik © 2026
                </p>
            </div>
        </div>
    );
}
