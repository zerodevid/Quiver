import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider, initLocale } from './i18n';
import './index.css';

initLocale();
createRoot(document.getElementById('root')).render(
  <StrictMode><I18nProvider><App /></I18nProvider></StrictMode>,
);
