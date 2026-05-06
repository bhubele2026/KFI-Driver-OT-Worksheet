import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "kfi-ot:drivers-sidebar:collapsed:v1";
const MOBILE_BREAKPOINT = 768;

function readStored(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function useSidebarCollapsed(): [boolean, (next: boolean) => void, () => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    const stored = readStored();
    if (stored !== null) return stored;
    if (typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT) {
      return true;
    }
    return false;
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const stored = readStored();
      if (stored !== null) setCollapsedState(stored);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
  }, [collapsed, setCollapsed]);

  return [collapsed, setCollapsed, toggle];
}
