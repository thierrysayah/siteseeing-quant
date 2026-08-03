import { useCallback, useEffect, useState } from 'react';

/**
 * Theme preference — single source of truth.
 *
 * The theme is a *per-user, per-device* preference, so it lives in
 * localStorage. It is deliberately NOT stored with a project: doing so meant
 * reopening a project re-applied whatever theme was saved with it, silently
 * overriding the user's current choice.
 */
const LS_KEY = 'quant.theme';
export const THEMES = ['dark', 'blueprint'];
const DEFAULT_THEME = 'dark';

/** Read the stored theme, falling back to the default for unknown/missing values. */
export function readTheme() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return THEMES.includes(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // private mode / storage disabled
  }
}

/** Apply a theme to the document. Safe to call before React mounts. */
export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', t);
  return t;
}

/**
 * useTheme — returns { theme, setTheme }.
 *
 * Applies the theme to <html data-theme>, persists every change, and stays in
 * sync across tabs via the `storage` event.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(readTheme);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(LS_KEY, theme); } catch { /* storage unavailable */ }
  }, [theme]);

  // Another tab changed the preference — follow it.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== LS_KEY) return;
      if (THEMES.includes(e.newValue)) setThemeState(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next) => {
    if (THEMES.includes(next)) setThemeState(next);
  }, []);

  return { theme, setTheme };
}
