/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: 'media',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
            },
            colors: {
                brand: {
                    blue: '#0052cc',
                    dark: '#0747a6',
                    light: '#4c9aff',
                    neon: '#00D4FF',
                    purple: '#7B2CBF',
                    pink: '#F72585',
                },
                primary: {
                    50: '#f0f7ff',
                    100: '#e0effe',
                    200: '#bae0fd',
                    300: '#7cc5fc',
                    400: '#36a8fa',
                    500: '#0052cc',
                    600: '#0043a6',
                    700: '#003685',
                    800: '#002e6b',
                    900: '#062856',
                },
                // Premium accent colors
                emerald: {
                    400: '#34d399',
                    500: '#10b981',
                    600: '#059669',
                },
                violet: {
                    400: '#a78bfa',
                    500: '#8b5cf6',
                    600: '#7c3aed',
                },
                amber: {
                    400: '#fbbf24',
                    500: '#f59e0b',
                    600: '#d97706',
                },
                rose: {
                    400: '#fb7185',
                    500: '#f43f5e',
                    600: '#e11d48',
                },
            },
            backgroundImage: {
                'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
                'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
                'aurora': 'linear-gradient(135deg, #667eea 0%, #764ba2 25%, #f093fb 50%, #4facfe 75%, #00f2fe 100%)',
                'glass-shine': 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
                'premium-blue': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                'premium-purple': 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                'premium-pink': 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                'premium-emerald': 'linear-gradient(135deg, #34d399 0%, #059669 100%)',
            },
            animation: {
                'fade-in': 'fadeIn 0.5s ease-out',
                'slide-up': 'slideUp 0.4s ease-out',
                'slide-down': 'slideDown 0.4s ease-out',
                'scale-in': 'scaleIn 0.3s ease-out',
                'shimmer': 'shimmer 2s linear infinite',
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'bounce-slow': 'bounce 2s infinite',
                'float': 'float 3s ease-in-out infinite',
                'glow': 'glow 2s ease-in-out infinite',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideUp: {
                    '0%': { transform: 'translateY(20px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                slideDown: {
                    '0%': { transform: 'translateY(-20px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                scaleIn: {
                    '0%': { transform: 'scale(0.9)', opacity: '0' },
                    '100%': { transform: 'scale(1)', opacity: '1' },
                },
                shimmer: {
                    '0%': { backgroundPosition: '-200% center' },
                    '100%': { backgroundPosition: '200% center' },
                },
                float: {
                    '0%, 100%': { transform: 'translateY(0px)' },
                    '50%': { transform: 'translateY(-10px)' },
                },
                glow: {
                    '0%, 100%': { opacity: '1', filter: 'drop-shadow(0 0 8px currentColor)' },
                    '50%': { opacity: '0.8', filter: 'drop-shadow(0 0 20px currentColor)' },
                },
            },
            boxShadow: {
                'glow-sm': '0 0 10px rgba(124, 58, 237, 0.5)',
                'glow-md': '0 0 20px rgba(124, 58, 237, 0.6)',
                'glow-lg': '0 0 30px rgba(124, 58, 237, 0.7)',
                'glow-blue': '0 0 20px rgba(0, 82, 204, 0.6)',
                'glow-pink': '0 0 20px rgba(247, 37, 133, 0.6)',
                'inner-glow': 'inset 0 0 20px rgba(255, 255, 255, 0.1)',
            },
        },
    },
    plugins: [],
}
