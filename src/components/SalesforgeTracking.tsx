"use client";

import { useEffect } from "react";
import { rememberLandingUtm } from "@/lib/salesforge/tracking";

/** Mounted once in the root layout: remembers the first landing page's UTM values for the lead forms. */
export function SalesforgeTracking() {
  useEffect(() => {
    rememberLandingUtm();
  }, []);
  return null;
}
