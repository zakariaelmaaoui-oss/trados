import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './push.js';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

// Register the service worker for PWA/offline shell. This does NOT request
// notification permission; that only happens from the Enable Notifications button.
if (import.meta.env.PROD) window.addEventListener('load', () => registerServiceWorker());
