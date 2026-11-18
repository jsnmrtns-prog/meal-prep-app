// Browser and device facts the app needs: Home Screen mode, storage, updates.

export function isStandalone(): boolean {
  return (
    navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export interface StorageStatus {
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const storage = navigator.storage;
  const persisted = storage?.persisted ? await storage.persisted().catch(() => null) : null;
  const estimate = storage?.estimate ? await storage.estimate().catch(() => null) : null;
  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
  };
}

/** Asks the browser not to evict this app's data. Returns the resulting state. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** Registers the service worker; calls onUpdate when a newer version takes over. */
export function registerServiceWorker(onUpdate: () => void): void {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) onUpdate();
  });
  const register = () => {
    navigator.serviceWorker.register("./sw.js").catch((error: unknown) => {
      console.warn("Service worker registration failed", error);
    });
  };
  // The app usually mounts after the load event has already fired.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
