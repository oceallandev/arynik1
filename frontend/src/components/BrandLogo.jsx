import React from 'react';

const sizeConfig = {
    sm: {
        root: 'gap-2.5',
        mark: 'w-10 h-10 rounded-2xl',
        name: 'text-xl',
        subtitle: 'text-[9px]',
    },
    md: {
        root: 'gap-3',
        mark: 'w-12 h-12 rounded-2xl',
        name: 'text-lg',
        subtitle: 'text-[10px]',
    },
    lg: {
        root: 'gap-4',
        mark: 'w-20 h-20 rounded-[24px]',
        name: 'text-4xl',
        subtitle: 'text-sm',
    },
};

export default function BrandLogo({
    size = 'md',
    subtitle = null,
    showStatus = false,
    statusLabel = 'Online',
    tone = 'default',
    stacked = false,
    className = '',
}) {
    const cfg = sizeConfig[size] || sizeConfig.md;
    const inverse = tone === 'inverse';

    return (
        <div className={`brand-logo ${stacked ? 'flex-col text-center' : 'flex-row'} ${cfg.root} ${className}`}>
            <div className={`brand-logo-mark ${cfg.mark}`} aria-hidden="true">
                <svg viewBox="0 0 96 96" className="h-full w-full" role="img">
                    <defs>
                        <linearGradient id="curieruSky" x1="18" y1="10" x2="76" y2="82" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stopColor="#38bdf8" />
                            <stop offset="0.52" stopColor="#2563eb" />
                            <stop offset="1" stopColor="#0f766e" />
                        </linearGradient>
                        <linearGradient id="curieruRoad" x1="10" y1="72" x2="88" y2="42" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stopColor="#16a34a" />
                            <stop offset="0.55" stopColor="#f59e0b" />
                            <stop offset="1" stopColor="#f97316" />
                        </linearGradient>
                        <linearGradient id="curieruTruck" x1="18" y1="50" x2="54" y2="68" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stopColor="#fbbf24" />
                            <stop offset="1" stopColor="#f97316" />
                        </linearGradient>
                    </defs>
                    <rect x="8" y="8" width="80" height="80" rx="22" fill="url(#curieruSky)" />
                    <path d="M19 66C38 76 63 72 82 49" fill="none" stroke="#052e16" strokeOpacity="0.34" strokeWidth="13" strokeLinecap="round" />
                    <path d="M17 61C37 74 63 69 82 45" fill="none" stroke="url(#curieruRoad)" strokeWidth="9" strokeLinecap="round" />
                    <path d="M24 43h23l10 9h8c4.4 0 8 3.6 8 8v9H24V43Z" fill="#075985" opacity="0.92" />
                    <path d="M16 52c0-5 4-9 9-9h20v26H16V52Z" fill="url(#curieruTruck)" />
                    <path d="M22 49h15v11H22V49Z" fill="#082f49" opacity="0.82" />
                    <path d="M42 49h9l7 8H42v-8Z" fill="#0c4a6e" opacity="0.85" />
                    <circle cx="29" cy="70" r="7" fill="#0f172a" />
                    <circle cx="29" cy="70" r="3.2" fill="#e2e8f0" />
                    <circle cx="66" cy="70" r="7" fill="#0f172a" />
                    <circle cx="66" cy="70" r="3.2" fill="#e2e8f0" />
                    <path d="M55 18c-8.8 0-16 7.1-16 15.9 0 12.2 16 28.1 16 28.1s16-15.9 16-28.1C71 25.1 63.8 18 55 18Z" fill="#0284c7" />
                    <circle cx="55" cy="34" r="8.6" fill="#0f172a" opacity="0.18" />
                    <path d="M49.5 33.6l4.1 4.1 8.2-8.4" fill="none" stroke="#f8fafc" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M22 38h21l11 6H22V38Z" fill="#e2e8f0" opacity="0.7" />
                    <path d="M27 30h20v8H27V30Z" fill="#f8fafc" opacity="0.78" />
                    <path d="M30 33h14" stroke="#0f172a" strokeOpacity="0.42" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 5" />
                </svg>
            </div>
            <div className={stacked ? 'min-w-0 text-center' : 'min-w-0'}>
                <div className={`brand-logo-name ${inverse ? 'brand-logo-name-inverse' : ''} ${cfg.name}`}>
                    Curieru
                </div>
                {subtitle ? (
                    <div className={`brand-logo-subtitle ${inverse ? 'brand-logo-subtitle-inverse' : ''} ${cfg.subtitle}`}>
                        {subtitle}
                    </div>
                ) : null}
                {showStatus ? (
                    <div className="mt-1 flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">{statusLabel}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
