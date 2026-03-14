import { KindlingScreen } from "@/components/kindling-screen";
import { getIsMobileDevice } from "@/lib/mobile-device.server";

export default async function RequestPage() {
  const isMobileDevice = await getIsMobileDevice();

  return (
    <KindlingScreen
      screen="request"
      isMobileCompatibilityMode={isMobileDevice}
    />
  );
}
