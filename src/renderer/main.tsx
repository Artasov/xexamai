import {createRoot} from 'react-dom/client';
import App from './App';
import './styles.css';
import './bridge/tauriApi';

const rootElement = document.getElementById('root');

if (!rootElement) {
    throw new Error('Root element #root not found');
}

createRoot(rootElement).render(<App/>);
