import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasApp } from './canvasApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>,
);
