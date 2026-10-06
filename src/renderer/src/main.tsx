import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { restoreMotion } from './lib/motion';

restoreMotion();
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
