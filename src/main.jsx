import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/begin-page.css';
import './styles/chrome.css';
import './styles/annotation.css';
import './styles/dashboard.css';
import './styles/modeling.css';
import './styles/training.css';
import './styles/submission.css';
import './styles/admin-neo.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
