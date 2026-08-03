import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// Theme tokens must load app-wide (not just inside the editor) so shared chrome
// like the top bar and the projects page can consume them.
import './theme.css';
import { applyTheme, readTheme } from './hooks/useTheme';
import App from './App';
import reportWebVitals from './reportWebVitals';



import { Amplify } from 'aws-amplify';
import awsExports from './aws-exports';


Amplify.configure(awsExports);

// Apply the saved theme before first paint so shared chrome (top bar, projects
// page, login) is themed immediately — the editor re-asserts this on mount.
applyTheme(readTheme());

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
