// Client-side hash forwarder: OAuth callbacks and deep links land on the
// domain root with a #token= or #pair= fragment; those belong to the app.
"use client";

import { useEffect } from "react";

export function shouldForwardToApp(hash: string, signedIn: boolean): boolean {
  return hash.startsWith("#token=") || hash.startsWith("#pair=") || signedIn;
}

export function HashForward() {
  useEffect(() => {
    const signedIn = (() => {
      try {
        return sessionStorage.getItem("cadero_oauth_token") !== null;
      } catch {
        return false;
      }
    })();
    if (shouldForwardToApp(window.location.hash, signedIn)) {
      window.location.replace(`/app${window.location.search}${window.location.hash}`);
    }
  }, []);
  return null;
}
