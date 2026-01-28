import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Import xlsx for global availability if needed, 
// though we use named imports in components.
// Ensure generic styles are applied via Tailwind in index.html

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
