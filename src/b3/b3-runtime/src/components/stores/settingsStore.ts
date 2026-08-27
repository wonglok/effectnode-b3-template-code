import { create } from "zustand";

// ---------------------------------------------------------------------------
// Settings Store
// ---------------------------------------------------------------------------
// Persisted user preferences (port number, etc.) backed by localStorage.
// Components that need the WebSocket URL read the port from here.
//
// SSR-safe: initialises with default values (server-compatible) and hydrates
// from localStorage on the client via `useSettingsStore.hydrate()` in a
// useEffect to avoid hydration mismatches.

const STORAGE_KEY = "timeversation-settings";

const DEFAULTS = { port: 8765 };

interface SettingsState {
  port: number;

  /** True once client-side localStorage values have been loaded. */
  hydrated: boolean;

  setPort: (port: number) => void;

  /** Call once in a useEffect to load persisted settings on the client. */
  hydrate: () => void;
}

function loadSettings(): { port: number } {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        port: typeof parsed.port === "number" ? parsed.port : DEFAULTS.port,
      };
    }
  } catch {
    // Corrupt data — fall through to defaults
  }
  return DEFAULTS;
}

function persist(state: { port: number }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: () => {
    // No-op if already hydrated or running on the server
    if (get().hydrated || typeof window === "undefined") return;

    const saved = loadSettings();
    // Only update if values differ from defaults (avoids unnecessary re-render)
    if (saved.port !== DEFAULTS.port) {
      set({ ...saved, hydrated: true });
    } else {
      set({ hydrated: true });
    }
  },

  setPort: (port) => {
    persist({ port });
    set({ port });
  },
}));
