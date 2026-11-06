import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { BRAND } from './branding/brand';
import './branding/brand.css';
import './styles.css';
import './components.css';
import './theme/theme.css';

document.title = BRAND.documentTitle;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);