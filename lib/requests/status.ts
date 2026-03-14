import type { ReadarrLookupBook, ReadarrQueueItem } from "@/lib/readarr/types";
import type {
  BookRequestFilter,
  BookRequestFormat,
  BookRequestStatus,
} from "@/lib/requests/types";

export const BOOK_REQUEST_STATUS_LABELS: Record<BookRequestStatus, string> = {
  requested: "Requested",
  searching: "Searching",
  downloading: "Downloading",
  available: "Ready",
  "not-monitored": "Not Monitored",
  failed: "Failed",
};

export const BOOK_REQUEST_FORMAT_LABELS: Record<BookRequestFormat, string> = {
  ebook: "EPUB",
  audiobook: "Audiobook",
};

export function isActiveStatus(status: BookRequestStatus) {
  return status === "requested" || status === "searching" || status === "downloading";
}

export function supportsKindleDelivery(format: BookRequestFormat) {
  return format === "ebook";
}

export function blocksNewRequest(status: BookRequestStatus) {
  return status !== "failed" && status !== "not-monitored";
}

export function matchesRequestFilter(status: BookRequestStatus, filter: BookRequestFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "active") {
    return isActiveStatus(status);
  }

  return status === "available";
}

export function mapReadarrBookToFriendlyStatus(
  book: ReadarrLookupBook,
  queueItems: ReadarrQueueItem[],
  previousStatus: BookRequestStatus = "requested",
) {
  if ((book.statistics?.bookFileCount ?? 0) > 0) {
    return {
      status: "available" as const,
      message: "Your book is ready.",
    };
  }

  if (book.monitored === false) {
    return {
      status: "not-monitored" as const,
      message: "This request is not monitored in Readarr right now.",
    };
  }

  const queueItem = queueItems.find((item) => item.bookId === book.id);

  if (queueItem?.errorMessage) {
    return {
      status: "failed" as const,
      message: "Readarr needs attention before this download can finish.",
    };
  }

  if (queueItem) {
    return {
      status: "downloading" as const,
      message: "The download is in progress.",
    };
  }

  if (book.lastSearchTime || previousStatus === "searching" || previousStatus === "downloading") {
    return {
      status: "searching" as const,
      message: "Readarr is still searching for a copy.",
    };
  }

  return {
    status: "requested" as const,
    message: "Your request has been saved.",
  };
}
