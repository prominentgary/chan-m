// store.js —— 本地持久化（localStorage）
const KEY = 'chan-m-state-v1';

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function save(state) {
  try {
    const payload = { ...state, savedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {}
}

export function clear() {
  localStorage.removeItem(KEY);
}
