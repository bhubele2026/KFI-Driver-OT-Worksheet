import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "kfi-ot:celebration-sound:v1";
const EVENT_NAME = "kfi-ot:celebration-sound:change";

function readPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

export function readCelebrationSoundPref(): boolean {
  return readPref();
}

export function useCelebrationSoundPref(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readPref());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setEnabled(detail);
      else setEnabled(readPref());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEnabled(readPref());
    };
    window.addEventListener(EVENT_NAME, onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // ignore quota / disabled storage
    }
    try {
      window.dispatchEvent(new CustomEvent<boolean>(EVENT_NAME, { detail: next }));
    } catch {
      // ignore in environments without CustomEvent
    }
  }, []);

  return [enabled, update];
}
