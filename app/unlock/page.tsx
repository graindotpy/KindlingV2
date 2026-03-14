import { UnlockScreen } from "@/app/unlock/unlock-screen";
import { getIsMobileDevice } from "@/lib/mobile-device.server";

function normalizeNextPath(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/";
  }

  return candidate;
}

export default async function UnlockPage(props: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const searchParams = await props.searchParams;
  const isMobileDevice = await getIsMobileDevice();

  return (
    <UnlockScreen
      nextPath={normalizeNextPath(searchParams.next)}
      isMobileCompatibilityMode={isMobileDevice}
    />
  );
}
