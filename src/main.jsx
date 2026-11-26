// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * main.jsx — the page's entry: its stylesheet, its start (src/app/boot.js: the
 * chats, the machines, what a reload cut off) and its one React root.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { boot } from './app/boot.js';
import App from './components/App.jsx';

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
boot();
