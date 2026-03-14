import "server-only";

import { headers } from "next/headers";
import { isMobileUserAgent } from "@/lib/mobile-device";

export async function getIsMobileDevice() {
  const requestHeaders = await headers();

  return isMobileUserAgent(requestHeaders.get("user-agent"));
}
