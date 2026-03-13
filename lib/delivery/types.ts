import type { BookRequestRecord } from "@/lib/requests/types";

export type DeliveryAction = {
  key: "send-to-kindle";
  enabled: boolean;
  label: string;
  reason: string;
};

export interface DeliveryActionProvider {
  getAvailableActions(request: BookRequestRecord): Promise<DeliveryAction[]>;
}

export const pendingDeliveryProvider: DeliveryActionProvider = {
  async getAvailableActions() {
    return [
      {
        key: "send-to-kindle",
        enabled: false,
        label: "Send to Kindle",
        reason: "This hook is reserved for the future EPUB delivery integration.",
      },
    ];
  },
};
