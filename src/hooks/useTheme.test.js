import { renderHook, act } from '@testing-library/react';
import { useTheme, readTheme, applyTheme, THEMES } from './useTheme';

const LS_KEY = 'quant.theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('readTheme', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(readTheme()).toBe('dark');
  });

  it('returns a stored valid theme', () => {
    localStorage.setItem(LS_KEY, 'blueprint');
    expect(readTheme()).toBe('blueprint');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem(LS_KEY, 'neon-pink');
    expect(readTheme()).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme on <html>', () => {
    applyTheme('blueprint');
    expect(document.documentElement.getAttribute('data-theme')).toBe('blueprint');
  });

  it('falls back to dark for an invalid theme', () => {
    applyTheme('bogus');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('useTheme', () => {
  it('applies and persists the chosen theme', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');

    act(() => result.current.setTheme('blueprint'));

    expect(result.current.theme).toBe('blueprint');
    expect(localStorage.getItem(LS_KEY)).toBe('blueprint');
    expect(document.documentElement.getAttribute('data-theme')).toBe('blueprint');
  });

  it('rejects an invalid theme', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('chartreuse'));
    expect(result.current.theme).toBe('dark');
  });

  // This is the exact bug reported: pick blueprint, switch to dark, navigate to
  // the projects page (editor unmounts) and reopen a project (editor remounts).
  // The remount must honour the *latest* choice, not the project's stored one.
  it('survives an unmount/remount cycle (reopening a project)', () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.setTheme('blueprint'));
    act(() => first.result.current.setTheme('dark'));
    first.unmount();                       // leave the editor -> projects page

    const second = renderHook(() => useTheme());  // reopen the project
    expect(second.result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('follows a change made in another tab', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');

    act(() => {
      localStorage.setItem(LS_KEY, 'blueprint');
      window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY, newValue: 'blueprint' }));
    });

    expect(result.current.theme).toBe('blueprint');
  });

  it('exposes exactly the two supported themes', () => {
    expect(THEMES).toEqual(['dark', 'blueprint']);
  });
});
