import { KindlingScreen } from "@/components/kindling-screen";
import { getIsMobileDevice } from "@/lib/mobile-device.server";

export default async function RequestedPage() {
  const isMobileDevice = await getIsMobileDevice();

  return (
    <KindlingScreen
      screen="requested"
      isMobileCompatibilityMode={isMobileDevice}
    />
  );
}
