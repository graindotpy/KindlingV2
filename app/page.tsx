import { KindlingScreen } from "@/components/kindling-screen";
import { getIsMobileDevice } from "@/lib/mobile-device.server";

export default async function Home() {
  const isMobileDevice = await getIsMobileDevice();

  return (
    <KindlingScreen
      screen="books"
      isMobileCompatibilityMode={isMobileDevice}
    />
  );
}
