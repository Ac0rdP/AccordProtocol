import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { registerServiceWorker, usePWAInstall } from "./pwa";

describe("PWA utilities", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("registers service worker on window load if supported", () => {
    const registerMock = vi.fn().mockResolvedValue({ scope: "/" });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      configurable: true,
    });

    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith("load", expect.any(Function));

    const loadHandler = addEventListenerSpy.mock.calls.find((call) => call[0] === "load")?.[1] as (() => void);
    expect(loadHandler).toBeTruthy();
    loadHandler();

    expect(registerMock).toHaveBeenCalledWith("/sw.js");
  });

  it("handles beforeinstallprompt and triggers promptInstall", async () => {
    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeInstallEvent = new Event("beforeinstallprompt");
    Object.assign(fakeInstallEvent, {
      prompt: promptMock,
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });

    const { result } = renderHook(() => usePWAInstall());

    expect(result.current.canInstall).toBe(false);

    act(() => {
      window.dispatchEvent(fakeInstallEvent);
    });

    expect(result.current.canInstall).toBe(true);

    let outcome = false;
    await act(async () => {
      outcome = await result.current.promptInstall();
    });

    expect(outcome).toBe(true);
    expect(promptMock).toHaveBeenCalled();
  });

  it("allows user to dismiss install prompt and remembers choice", () => {
    const fakeInstallEvent = new Event("beforeinstallprompt");
    Object.assign(fakeInstallEvent, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    });

    const { result } = renderHook(() => usePWAInstall());

    act(() => {
      window.dispatchEvent(fakeInstallEvent);
    });
    expect(result.current.canInstall).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.canInstall).toBe(false);
    expect(store["accord_pwa_install_dismissed"]).toBe("true");
  });
});
