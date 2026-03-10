import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initTheme } from './services/theme';

import { AuthProvider } from './context/AuthContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'

initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <LanguageProvider>
            <AuthProvider>
                <App />
            </AuthProvider>
        </LanguageProvider>
    </React.StrictMode>,
)
