/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import styles from "@/components/kindling-screen.module.css";
import type { DeliverySettings, SendToKindleResult } from "@/lib/delivery/types";
import { createLatestRequestGate } from "@/lib/search/latest-request";
import {
  BOOK_REQUEST_FORMAT_LABELS,
  BOOK_REQUEST_STATUS_LABELS,
  matchesRequestFilter,
  supportsKindleDelivery,
} from "@/lib/requests/status";
import type {
  BookRequestFilter,
  BookRequestFormat,
  BookRequestRecord,
  LocalUser,
  SearchResultItem,
} from "@/lib/requests/types";

type KindlingScreenProps = {
  screen: "books" | "request" | "requested";
  isMobileCompatibilityMode?: boolean;
};

const FILTERS: Array<{ key: BookRequestFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "available", label: "Available" },
];

const REQUEST_FORMATS: BookRequestFormat[] = ["ebook", "audiobook"];

async function fetchJson<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | T
    | null;

  if (response.status === 401 && typeof window !== "undefined") {
    const next = encodeURIComponent(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
    window.location.assign(`/unlock?next=${next}`);
    throw new Error("Redirecting to unlock Kindling.");
  }

  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "message" in payload && payload.message
        ? payload.message
        : "Something went wrong.",
    );
  }

  return payload as T;
}

function formatRequestedDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getFilenameFromPath(value: string | null) {
  if (!value) {
    return null;
  }

  return value.split(/[/\\]/).pop() ?? value;
}

function buildProfileDraft(user: LocalUser) {
  return {
    name: user.name,
    kindleEmail: user.kindleEmail ?? "",
  };
}

function sortUsersByName(entries: LocalUser[]) {
  return [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    }),
  );
}

function formatSavedRequestCount(count: number) {
  return `${count} saved request${count === 1 ? "" : "s"}`;
}

function getProfileDeleteDisabledReason(user: LocalUser, totalProfiles: number) {
  if (user.requestCount > 0) {
    return `Delete is disabled while ${formatSavedRequestCount(user.requestCount)} ${user.requestCount === 1 ? "is" : "are"} attached to this profile.`;
  }

  if (totalProfiles <= 1) {
    return "Add another household profile before deleting this one.";
  }

  return null;
}

function statusTone(status: BookRequestRecord["status"]) {
  switch (status) {
    case "available":
      return styles.statusAvailable;
    case "downloading":
      return styles.statusDownloading;
    case "not-monitored":
      return styles.statusNotMonitored;
    case "searching":
      return styles.statusSearching;
    case "failed":
      return styles.statusFailed;
    default:
      return styles.statusRequested;
  }
}

function EmptyState(props: {
  title: string;
  body: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>K</div>
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      {props.actionLabel && props.actionHref ? (
        <Link href={props.actionHref} className={styles.ghostButton}>
          {props.actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function SkeletonCards(props: { household?: boolean }) {
  const gridClassName = props.household
    ? `${styles.cardGrid} ${styles.householdCardGrid}`
    : styles.cardGrid;

  return (
    <div className={gridClassName}>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className={`${styles.card} ${styles.skeletonCard}`}>
          <div className={styles.skeletonCover} />
          <div className={styles.skeletonLine} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        </div>
      ))}
    </div>
  );
}

function Cover(props: { title: string; imageUrl: string | null; size?: "large" | "small" }) {
  const sizeClass = props.size === "small" ? styles.coverSmall : styles.coverLarge;

  if (props.imageUrl) {
    return <img src={props.imageUrl} alt="" className={`${styles.cover} ${sizeClass}`} />;
  }

  return (
    <div className={`${styles.coverFallback} ${sizeClass}`}>
      <span>{props.title.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

function RequestCard(props: {
  request: BookRequestRecord;
  syncing: boolean;
  clearing: boolean;
  onSync: (requestId: number) => void;
  onClear: (requestId: number) => void;
  showRequester?: boolean;
  showDeliveryControls?: boolean;
  smtpConfigured?: boolean;
  smtpMessage?: string | null;
  deliveryUsers?: LocalUser[];
  selectedRecipientId?: number;
  sending?: boolean;
  onRecipientChange?: (requestId: number, userId: number) => void;
  onSendToKindle?: (requestId: number) => void;
}) {
  const availableFile = getFilenameFromPath(props.request.matchedFilePath);
  const selectedRecipient =
    props.deliveryUsers?.find((user) => user.id === props.selectedRecipientId) ?? null;
  const canDeliver = supportsKindleDelivery(props.request.requestFormat);
  const canSend =
    Boolean(props.request.matchedFilePath) &&
    canDeliver &&
    Boolean(props.smtpConfigured) &&
    Boolean(selectedRecipient?.kindleEmail);

  return (
    <article className={styles.card}>
      <Cover title={props.request.requestedTitle} imageUrl={props.request.coverUrl} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <div>
            <h3>{props.request.requestedTitle}</h3>
            <p className={styles.subtleText}>
              {props.request.requestedAuthor}
              {` - ${BOOK_REQUEST_FORMAT_LABELS[props.request.requestFormat]}`}
            </p>
          </div>
          <span className={`${styles.statusPill} ${statusTone(props.request.status)}`}>
            {BOOK_REQUEST_STATUS_LABELS[props.request.status]}
          </span>
        </div>
        <dl className={styles.metaGrid}>
          {props.showRequester ? (
            <div>
              <dt>Requested by</dt>
              <dd>{props.request.userName}</dd>
            </div>
          ) : null}
          <div>
            <dt>Requested</dt>
            <dd>{formatRequestedDate(props.request.requestedAt)}</dd>
          </div>
          <div>
            <dt>Latest update</dt>
            <dd>{props.request.statusMessage ?? "Saved in Kindling."}</dd>
          </div>
          {availableFile ? (
            <div>
              <dt>Matched file</dt>
              <dd>{availableFile}</dd>
            </div>
          ) : null}
          {props.request.lastDeliveryMessage ? (
            <div>
              <dt>Last delivery</dt>
              <dd>{props.request.lastDeliveryMessage}</dd>
            </div>
          ) : null}
        </dl>

        {props.showDeliveryControls && canDeliver ? (
          <div className={styles.deliveryPanel}>
            <div className={styles.inlineFieldGroup}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Send to Kindle</span>
                <select
                  className={styles.selectInput}
                  value={props.selectedRecipientId ?? ""}
                  onChange={(event) =>
                    props.onRecipientChange?.(
                      props.request.id,
                      Number(event.target.value),
                    )
                  }
                >
                  {props.deliveryUsers?.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                      {user.kindleEmail ? ` - ${user.kindleEmail}` : " - no Kindle email"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => props.onSendToKindle?.(props.request.id)}
                disabled={props.sending || !canSend}
              >
                {props.sending ? "Sending..." : "Send to Kindle"}
              </button>
            </div>
            <p className={styles.systemNote}>
              {!props.request.matchedFilePath
                ? "Waiting for this book file to appear in the watched folder."
                : !props.smtpConfigured
                  ? props.smtpMessage ?? "SMTP is not ready for Kindle delivery yet."
                  : !selectedRecipient?.kindleEmail
                    ? "Add a Kindle email to this profile before sending."
                    : `Ready to send ${availableFile}.`}
            </p>
          </div>
        ) : null}

        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => props.onSync(props.request.id)}
            disabled={props.syncing || props.clearing}
          >
            {props.syncing ? "Refreshing..." : "Refresh status"}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => props.onClear(props.request.id)}
            disabled={props.syncing || props.clearing}
          >
            {props.clearing ? "Deleting..." : "Delete request"}
          </button>
        </div>
      </div>
    </article>
  );
}

function SearchResultCard(props: {
  result: SearchResultItem;
  busyFormat: BookRequestFormat | null;
  onRequest: (result: SearchResultItem, requestFormat: BookRequestFormat) => void;
}) {
  return (
    <article className={styles.card}>
      <Cover title={props.result.title} imageUrl={props.result.coverUrl} size="small" />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <div>
            <h3>{props.result.title}</h3>
            <p className={styles.subtleText}>
              {props.result.author}
              {props.result.year ? ` - ${props.result.year}` : ""}
            </p>
          </div>
        </div>
        <div className={styles.requestOptionGrid}>
          {REQUEST_FORMATS.map((format) => {
            const action = props.result.actions[format];
            const isRequestable = action.availability === "requestable";
            const busy = props.busyFormat === format;
            const formatLabel = BOOK_REQUEST_FORMAT_LABELS[format];
            const requestLabel = `Request ${formatLabel}`;

            return (
              <button
                key={format}
                type="button"
                className={isRequestable ? styles.primaryButton : styles.secondaryButton}
                onClick={isRequestable ? () => props.onRequest(props.result, format) : undefined}
                disabled={busy || !isRequestable}
                title={!isRequestable ? action.availabilityDescription : undefined}
                aria-label={`${requestLabel}. ${action.availabilityLabel}.`}
              >
                {busy ? `Requesting ${formatLabel}...` : requestLabel}
              </button>
            );
          })}
        </div>
      </div>
    </article>
  );
}

export function KindlingScreen({
  screen,
  isMobileCompatibilityMode = false,
}: KindlingScreenProps) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [profileDrafts, setProfileDrafts] = useState<
    Record<number, { name: string; kindleEmail: string }>
  >({});
  const [newProfileDraft, setNewProfileDraft] = useState({
    name: "",
    kindleEmail: "",
  });
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [requests, setRequests] = useState<BookRequestRecord[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(screen !== "request");
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestsMessage, setRequestsMessage] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<BookRequestFilter>("all");
  const [syncingRequestId, setSyncingRequestId] = useState<number | null>(null);
  const [clearingRequestId, setClearingRequestId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [requestingActionKey, setRequestingActionKey] = useState<string | null>(null);
  const [lastSearchedQuery, setLastSearchedQuery] = useState("");
  const [deliverySettings, setDeliverySettings] = useState<DeliverySettings | null>(null);
  const [watchDirectoryDraft, setWatchDirectoryDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [profileCreating, setProfileCreating] = useState(false);
  const [profileSavingId, setProfileSavingId] = useState<number | null>(null);
  const [profileDeletingId, setProfileDeletingId] = useState<number | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [deliveryTargets, setDeliveryTargets] = useState<Record<number, number>>({});
  const [sendingRequestId, setSendingRequestId] = useState<number | null>(null);
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const activeSearchQueryRef = useRef<string | null>(null);
  const latestSearchRequestRef = useRef(createLatestRequestGate());
  const isHouseholdScreen = screen === "requested";
  const isRequestListScreen = screen !== "request";

  const filteredRequests = requests.filter((request) =>
    matchesRequestFilter(request.status, activeFilter),
  );

  const loadUsers = useCallback(async () => {
    const data = sortUsersByName(await fetchJson<LocalUser[]>("/api/users"));
    setUsers(data);
    setProfileDrafts(
      Object.fromEntries(
        data.map((user) => [user.id, buildProfileDraft(user)]),
      ),
    );
    return data;
  }, []);

  const loadDeliverySettings = useCallback(async () => {
    const data = await fetchJson<DeliverySettings>("/api/settings/delivery");
    setDeliverySettings(data);
    setWatchDirectoryDraft(data.watchDirectory ?? "");
    return data;
  }, []);

  const resetSearchState = useCallback(() => {
    latestSearchRequestRef.current.invalidate();
    activeSearchQueryRef.current = null;
    setSearchLoading(false);
  }, []);

  const refreshRequests = useCallback(
    async (silent = false) => {
      if (!isHouseholdScreen && !selectedUserId) {
        return;
      }

      if (!silent) {
        setRequestsLoading(true);
      }

      setRequestsError(null);
      if (!silent) {
        setRequestsMessage(null);
      }

      try {
        const data = isHouseholdScreen
          ? await fetchJson<BookRequestRecord[]>("/api/requests/all")
          : await fetchJson<BookRequestRecord[]>(`/api/requests?userId=${selectedUserId}`);
        setRequests(data);
      } catch (error) {
        setRequestsError(
          error instanceof Error
            ? error.message
            : isHouseholdScreen
              ? "Could not load the household requests."
              : "Could not load your books.",
        );
      } finally {
        setRequestsLoading(false);
      }
    },
    [isHouseholdScreen, selectedUserId],
  );

  const performSearch = useCallback(
    async (query: string) => {
      if (!selectedUserId) {
        return;
      }

      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        resetSearchState();
        setSearchError("Please enter a title or author.");
        setSearchResults([]);
        setLastSearchedQuery("");
        return;
      }

      const requestId = latestSearchRequestRef.current.begin();
      activeSearchQueryRef.current = trimmedQuery;
      setSearchLoading(true);
      setSearchError(null);

      try {
        const encodedQuery = encodeURIComponent(trimmedQuery);
        const data = await fetchJson<SearchResultItem[]>(
          `/api/search?q=${encodedQuery}&userId=${selectedUserId}`,
        );
        if (!latestSearchRequestRef.current.isCurrent(requestId)) {
          return;
        }
        setSearchResults(data);
        setLastSearchedQuery(trimmedQuery);
      } catch (error) {
        if (!latestSearchRequestRef.current.isCurrent(requestId)) {
          return;
        }
        setSearchError(error instanceof Error ? error.message : "Search is unavailable.");
        setSearchResults([]);
      } finally {
        if (!latestSearchRequestRef.current.isCurrent(requestId)) {
          return;
        }
        activeSearchQueryRef.current = null;
        setSearchLoading(false);
      }
    },
    [resetSearchState, selectedUserId],
  );

  const maybeRunSearch = useCallback(async () => {
    const trimmedQuery = searchQuery.trim();

    if (!trimmedQuery) {
      resetSearchState();
      setSearchError(null);
      setSearchResults([]);
      setLastSearchedQuery("");
      return;
    }

    if (trimmedQuery === lastSearchedQuery) {
      return;
    }

    if (activeSearchQueryRef.current === trimmedQuery) {
      return;
    }

    await performSearch(trimmedQuery);
  }, [lastSearchedQuery, performSearch, resetSearchState, searchQuery]);

  useEffect(() => {
    void (async () => {
      const data = await loadUsers();

      const savedUserId = Number(window.localStorage.getItem("kindling:selected-user"));
      const nextUserId =
        data.find((user) => user.id === savedUserId)?.id ?? data[0]?.id ?? null;
      setSelectedUserId(nextUserId);
    })().catch((error: unknown) => {
      setRequestsError(
        error instanceof Error ? error.message : "We could not load the family list.",
      );
    });
  }, [loadUsers]);

  useEffect(() => {
    if (!isHouseholdScreen) {
      return;
    }

    void loadDeliverySettings().catch((error: unknown) => {
      setSettingsError(
        error instanceof Error
          ? error.message
          : "We could not load the Kindle delivery settings.",
      );
    });
  }, [isHouseholdScreen, loadDeliverySettings]);

  useEffect(() => {
    if (!selectedUserId) {
      return;
    }

    window.localStorage.setItem("kindling:selected-user", String(selectedUserId));
  }, [selectedUserId]);

  useEffect(() => {
    if (screen === "books" && !selectedUserId) {
      return;
    }

    if (!isRequestListScreen) {
      return;
    }

    void refreshRequests();

    const intervalId = window.setInterval(() => {
      void refreshRequests(true);
    }, 45000);

    return () => window.clearInterval(intervalId);
  }, [isRequestListScreen, refreshRequests, screen, selectedUserId]);

  useEffect(() => {
    resetSearchState();
    setSearchResults([]);
    setSearchError(null);
    setLastSearchedQuery("");
  }, [resetSearchState, selectedUserId]);

  useEffect(() => {
    setDeliveryTargets((current) => {
      const next = { ...current };
      let changed = false;

      for (const request of requests) {
        const currentTarget = next[request.id];
        const validTarget = users.some((user) => user.id === currentTarget);

        if (!validTarget) {
          next[request.id] = request.userId;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [requests, users]);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const canRenderRequestSection = isHouseholdScreen || Boolean(selectedUser);
  const pageClassName = isMobileCompatibilityMode
    ? `${styles.page} ${styles.pageMobile}`
    : styles.page;

  const counts = {
    all: requests.length,
    active: requests.filter((request) => matchesRequestFilter(request.status, "active")).length,
    available: requests.filter((request) =>
      matchesRequestFilter(request.status, "available"),
    ).length,
  };

  async function handleRequest(
    result: SearchResultItem,
    requestFormat: BookRequestFormat,
  ) {
    if (!selectedUserId) {
      return;
    }

    const action = result.actions[requestFormat];
    if (!action.source) {
      setSearchError(action.availabilityDescription);
      return;
    }

    const actionKey = `${result.fingerprint}:${requestFormat}`;

    setRequestingActionKey(actionKey);
    setSearchError(null);

    try {
      const created = await fetchJson<BookRequestRecord>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          userId: selectedUserId,
          requestFormat,
          selection: action.source,
        }),
      });

      setSearchResults((current) =>
        current.map((entry) =>
          entry.fingerprint === result.fingerprint
            ? {
                ...entry,
                actions: {
                  ...entry.actions,
                  [requestFormat]: {
                    ...entry.actions[requestFormat],
                    availability: "requested-by-you",
                    availabilityLabel: "Already in My List",
                    availabilityDescription: created.statusMessage ?? "Saved in your list.",
                    request: created,
                  },
                },
              }
            : entry,
        ),
      );

      await refreshRequests(true);
    } catch (error) {
      setSearchError(
        error instanceof Error ? error.message : "We could not save that request.",
      );
    } finally {
      setRequestingActionKey(null);
    }
  }

  async function handleSyncRequest(requestId: number) {
    setSyncingRequestId(requestId);
    setRequestsError(null);
    setRequestsMessage(null);

    try {
      const updated = await fetchJson<BookRequestRecord>(`/api/requests/${requestId}/sync`, {
        method: "POST",
      });

      setRequests((current) =>
        updated.status === "not-monitored"
          ? current.filter((request) => request.id !== updated.id)
          : current.map((request) => (request.id === updated.id ? updated : request)),
      );
    } catch (error) {
      setRequestsError(
        error instanceof Error ? error.message : "We could not refresh that request.",
      );
    } finally {
      setSyncingRequestId(null);
    }
  }

  async function handleClearRequest(requestId: number) {
    const shouldClear = window.confirm(
      "Delete this request from Readarr? Kindling will delete any existing file it can find and reset the request to Not Monitored.",
    );
    if (!shouldClear) {
      return;
    }

    setClearingRequestId(requestId);
    setRequestsError(null);
    setRequestsMessage(null);

    try {
      const updated = await fetchJson<BookRequestRecord>(`/api/requests/${requestId}`, {
        method: "DELETE",
      });

      setRequests((current) => current.filter((request) => request.id !== updated.id));
      setRequestsMessage(updated.statusMessage ?? "Request deleted.");
    } catch (error) {
      setRequestsError(
        error instanceof Error ? error.message : "We could not delete that request.",
      );
    } finally {
      setClearingRequestId(null);
    }
  }

  async function handleProfileSave(userId: number) {
    const draft = profileDrafts[userId];
    if (!draft) {
      return;
    }

    setProfileSavingId(userId);
    setProfileError(null);
    setProfileMessage(null);

    try {
      const updated = await fetchJson<LocalUser>(`/api/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify(draft),
      });

      setUsers((current) =>
        sortUsersByName(current.map((user) => (user.id === updated.id ? updated : user))),
      );
      setProfileDrafts((current) => ({
        ...current,
        [updated.id]: buildProfileDraft(updated),
      }));
      setProfileMessage(`Saved ${updated.name}'s profile.`);
      await refreshRequests(true);
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "We could not save that profile.",
      );
    } finally {
      setProfileSavingId(null);
    }
  }

  async function handleProfileCreate() {
    setProfileCreating(true);
    setProfileError(null);
    setProfileMessage(null);

    try {
      const created = await fetchJson<LocalUser>("/api/users", {
        method: "POST",
        body: JSON.stringify(newProfileDraft),
      });

      setUsers((current) => sortUsersByName([...current, created]));
      setProfileDrafts((current) => ({
        ...current,
        [created.id]: buildProfileDraft(created),
      }));
      setNewProfileDraft({
        name: "",
        kindleEmail: "",
      });
      setSelectedUserId(created.id);
      setProfileMessage(`Added ${created.name}'s profile.`);
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "We could not add that profile.",
      );
    } finally {
      setProfileCreating(false);
    }
  }

  async function handleProfileDelete(user: LocalUser) {
    const shouldDelete = window.confirm(`Delete ${user.name}'s profile from Kindling?`);
    if (!shouldDelete) {
      return;
    }

    setProfileDeletingId(user.id);
    setProfileError(null);
    setProfileMessage(null);

    try {
      const deleted = await fetchJson<LocalUser>(`/api/users/${user.id}`, {
        method: "DELETE",
      });
      const nextUsers = sortUsersByName(users.filter((entry) => entry.id !== deleted.id));

      setUsers(nextUsers);
      setProfileDrafts((current) => {
        const next = { ...current };
        delete next[deleted.id];
        return next;
      });

      if (selectedUserId === deleted.id) {
        setSelectedUserId(nextUsers[0]?.id ?? null);
      }

      setProfileMessage(`Deleted ${deleted.name}'s profile.`);
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "We could not delete that profile.",
      );
    } finally {
      setProfileDeletingId(null);
    }
  }

  async function handleSaveWatchDirectory() {
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const updated = await fetchJson<DeliverySettings>("/api/settings/delivery", {
        method: "PUT",
        body: JSON.stringify({
          watchDirectory: watchDirectoryDraft,
        }),
      });

      setDeliverySettings(updated);
      setWatchDirectoryDraft(updated.watchDirectory ?? "");
      setSettingsMessage(
        updated.watchDirectory
          ? updated.watchDirectoryMessage
          : "Watched folder cleared.",
      );
      await refreshRequests(true);
    } catch (error) {
      setSettingsError(
        error instanceof Error ? error.message : "We could not save the watched folder.",
      );
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleSendToKindle(requestId: number) {
    const recipientUserId = deliveryTargets[requestId];
    if (!recipientUserId) {
      return;
    }

    setSendingRequestId(requestId);
    setDeliveryError(null);
    setDeliveryMessage(null);

    try {
      const result = await fetchJson<SendToKindleResult>(`/api/requests/${requestId}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          recipientUserId,
        }),
      });

      setRequests((current) =>
        current.map((request) => (request.id === result.request.id ? result.request : request)),
      );
      setDeliveryMessage(result.attempt.message ?? "Book sent to Kindle.");
    } catch (error) {
      setDeliveryError(
        error instanceof Error ? error.message : "We could not send that book right now.",
      );
    } finally {
      setSendingRequestId(null);
    }
  }

  return (
    <main className={pageClassName}>
      <section className={styles.hero}>
        <div className={styles.heroBrand}>
          <img src="/kindling-mark.svg" alt="" className={styles.brandMark} />
          <div>
            <h1>Kindling</h1>
          </div>
        </div>
        {screen === "books" ? null : (
          <p className={styles.heroText}>
            {screen === "request"
              ? "Search by title or author, then choose EPUB or Audiobook with one tap."
              : "A full household view of every request Kindling has recorded."}
          </p>
        )}
      </section>

      <section className={styles.shell}>
        <header className={styles.topBar}>
          <div>
            {isHouseholdScreen ? (
              <>
                <p className={styles.sectionLabel}>Household requests</p>
                <p className={styles.topBarText}>
                  Browse every saved request across the family in one place.
                </p>
              </>
            ) : (
              <>
                <p className={styles.sectionLabel}>Who is using Kindling?</p>
                <div className={styles.userRow}>
                  {users.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className={`${styles.userChip} ${
                        user.id === selectedUserId ? styles.userChipActive : ""
                      }`}
                      onClick={() =>
                        startTransition(() => {
                          setSelectedUserId(user.id);
                        })
                      }
                    >
                      {user.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <nav className={styles.navTabs} aria-label="Main navigation">
            <Link
              href="/"
              className={`${styles.navTab} ${screen === "books" ? styles.navTabActive : ""}`}
            >
              My books
            </Link>
            <Link
              href="/request"
              className={`${styles.navTab} ${screen === "request" ? styles.navTabActive : ""}`}
            >
              Request book
            </Link>
            <Link
              href="/requested"
              className={`${styles.navTab} ${screen === "requested" ? styles.navTabActive : ""}`}
            >
              All requests
            </Link>
          </nav>
        </header>

        {canRenderRequestSection ? (
          <section className={styles.sectionCard}>
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionLabel}>
                  {screen === "books"
                    ? "My Requests"
                    : screen === "request"
                      ? "Request Title"
                      : "All Requests"}
                </p>
                <h2>
                  {screen === "books"
                    ? `${selectedUser?.name}'s requests`
                    : screen === "request"
                      ? `Search for a title for ${selectedUser?.name}`
                      : "Household Requests"}
                </h2>
              </div>
              {isRequestListScreen ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshRequests()}
                >
                  Refresh all
                </button>
              ) : null}
            </div>

            {isRequestListScreen ? (
              <>
                <div className={styles.filterRow}>
                  {FILTERS.map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      className={`${styles.filterChip} ${
                        activeFilter === filter.key ? styles.filterChipActive : ""
                      }`}
                      onClick={() => setActiveFilter(filter.key)}
                    >
                      {filter.label} ({counts[filter.key]})
                    </button>
                  ))}
                </div>

                {requestsError ? <p className={styles.errorBanner}>{requestsError}</p> : null}
                {requestsMessage ? (
                  <p className={styles.successBanner}>{requestsMessage}</p>
                ) : null}
                {deliveryError ? <p className={styles.errorBanner}>{deliveryError}</p> : null}
                {deliveryMessage ? (
                  <p className={styles.successBanner}>{deliveryMessage}</p>
                ) : null}

                {requestsLoading ? (
                  <SkeletonCards household={isHouseholdScreen} />
                ) : filteredRequests.length > 0 ? (
                  <div
                    className={
                      isHouseholdScreen
                        ? `${styles.cardGrid} ${styles.householdCardGrid}`
                        : styles.cardGrid
                    }
                  >
                    {filteredRequests.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        syncing={syncingRequestId === request.id}
                        clearing={clearingRequestId === request.id}
                        onSync={handleSyncRequest}
                        onClear={handleClearRequest}
                        showRequester={isHouseholdScreen}
                        showDeliveryControls={isHouseholdScreen}
                        smtpConfigured={deliverySettings?.smtpConfigured}
                        smtpMessage={deliverySettings?.smtpMessage}
                        deliveryUsers={users}
                        selectedRecipientId={deliveryTargets[request.id]}
                        sending={sendingRequestId === request.id}
                        onRecipientChange={(requestId, userId) =>
                          setDeliveryTargets((current) => ({
                            ...current,
                            [requestId]: userId,
                          }))
                        }
                        onSendToKindle={handleSendToKindle}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={isHouseholdScreen ? "No requests yet" : "No books here yet"}
                    body={
                      isHouseholdScreen
                        ? "When someone requests a book, it will appear here with its latest status."
                        : "When you request an EPUB or Audiobook, it will show up here with a clear status."
                    }
                    actionLabel="Request a book"
                    actionHref="/request"
                  />
                )}
              </>
            ) : (
              <>
                <form
                  className={styles.searchBar}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void maybeRunSearch();
                  }}
                >
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onBlur={() => {
                      void maybeRunSearch();
                    }}
                    className={styles.searchInput}
                    placeholder="Try a title, author, or both"
                  />
                  <button type="submit" className={styles.primaryButton} disabled={searchLoading}>
                    {searchLoading ? "Searching..." : "Search"}
                  </button>
                </form>

                {searchError ? <p className={styles.errorBanner}>{searchError}</p> : null}

                {searchLoading ? (
                  <SkeletonCards />
                ) : searchResults.length > 0 ? (
                  <div className={styles.cardGrid}>
                    {searchResults.map((result) => (
                      <SearchResultCard
                        key={result.fingerprint}
                        result={result}
                        busyFormat={
                          REQUEST_FORMATS.find(
                            (format) =>
                              requestingActionKey === `${result.fingerprint}:${format}`,
                          ) ?? null
                        }
                        onRequest={handleRequest}
                      />
                    ))}
                  </div>
                ) : searchQuery.trim() ? (
                  <EmptyState
                    title="No matches yet"
                    body="Try another title, author, or spelling. If Readarr is offline, Kindling will let you know."
                  />
                ) : (
                  <EmptyState
                    title="Search to begin"
                    body="Type the title or author you want, then choose EPUB or Audiobook for the right match."
                  />
                )}
              </>
            )}
          </section>
        ) : (
          <section className={styles.sectionCard}>
            <EmptyState
              title="Loading your family list"
              body="Kindling is getting everything ready."
            />
          </section>
        )}

        {isHouseholdScreen ? (
          <section className={styles.sectionCard}>
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionLabel}>Profiles and delivery</p>
                <h2>Configure Kindles and the watched folder</h2>
              </div>
            </div>

            {profileError ? <p className={styles.errorBanner}>{profileError}</p> : null}
            {profileMessage ? <p className={styles.successBanner}>{profileMessage}</p> : null}
            {settingsError ? <p className={styles.errorBanner}>{settingsError}</p> : null}
            {settingsMessage ? <p className={styles.successBanner}>{settingsMessage}</p> : null}

            <div className={styles.settingsGrid}>
              <div className={styles.settingsPane}>
                <p className={styles.sectionLabel}>Profiles</p>
                <div className={styles.profileList}>
                  <form
                    className={styles.profileCard}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleProfileCreate();
                    }}
                  >
                    <p className={styles.cardMessage}>
                      Add a household profile for its own requests and Kindle delivery address.
                    </p>
                    <div className={styles.formGrid}>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Profile name</span>
                        <input
                          type="text"
                          className={styles.textInput}
                          value={newProfileDraft.name}
                          onChange={(event) =>
                            setNewProfileDraft((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          placeholder="Aunt May"
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Kindle email</span>
                        <input
                          type="email"
                          className={styles.textInput}
                          value={newProfileDraft.kindleEmail}
                          onChange={(event) =>
                            setNewProfileDraft((current) => ({
                              ...current,
                              kindleEmail: event.target.value,
                            }))
                          }
                          placeholder="name@kindle.com"
                        />
                      </label>
                    </div>
                    <button
                      type="submit"
                      className={styles.primaryButton}
                      disabled={profileCreating}
                    >
                      {profileCreating ? "Adding..." : "Add profile"}
                    </button>
                  </form>
                  {users.map((user) => {
                    const deleteDisabledReason = getProfileDeleteDisabledReason(
                      user,
                      users.length,
                    );

                    return (
                      <form
                        key={user.id}
                        className={styles.profileCard}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void handleProfileSave(user.id);
                        }}
                      >
                        <div className={styles.formGrid}>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Profile name</span>
                            <input
                              type="text"
                              className={styles.textInput}
                              value={profileDrafts[user.id]?.name ?? ""}
                              onChange={(event) =>
                                setProfileDrafts((current) => ({
                                  ...current,
                                  [user.id]: {
                                    name: event.target.value,
                                    kindleEmail: current[user.id]?.kindleEmail ?? "",
                                  },
                                }))
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span className={styles.fieldLabel}>Kindle email</span>
                            <input
                              type="email"
                              className={styles.textInput}
                              value={profileDrafts[user.id]?.kindleEmail ?? ""}
                              onChange={(event) =>
                                setProfileDrafts((current) => ({
                                  ...current,
                                  [user.id]: {
                                    name: current[user.id]?.name ?? user.name,
                                    kindleEmail: event.target.value,
                                  },
                                }))
                              }
                              placeholder="name@kindle.com"
                            />
                          </label>
                        </div>
                        <p className={styles.cardMessage}>
                          {user.requestCount > 0
                            ? `${formatSavedRequestCount(user.requestCount)} ${user.requestCount === 1 ? "is" : "are"} attached to this profile.`
                            : "No saved requests are attached to this profile yet."}
                        </p>
                        {deleteDisabledReason ? (
                          <p className={styles.systemNote}>{deleteDisabledReason}</p>
                        ) : null}
                        <div className={styles.actionRow}>
                          <button
                            type="submit"
                            className={styles.secondaryButton}
                            disabled={
                              profileSavingId === user.id || profileDeletingId === user.id
                            }
                          >
                            {profileSavingId === user.id ? "Saving..." : "Save profile"}
                          </button>
                          <button
                            type="button"
                            className={styles.dangerButton}
                            onClick={() => void handleProfileDelete(user)}
                            disabled={
                              profileSavingId === user.id ||
                              profileDeletingId === user.id ||
                              Boolean(deleteDisabledReason)
                            }
                          >
                            {profileDeletingId === user.id ? "Deleting..." : "Delete profile"}
                          </button>
                        </div>
                      </form>
                    );
                  })}
                </div>
              </div>

              <form
                className={styles.settingsPane}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveWatchDirectory();
                }}
              >
                <p className={styles.sectionLabel}>Watched folder</p>
                <p className={styles.cardMessage}>
                  Kindling scans this folder and every subfolder. When a requested book shows up
                  there, it marks the request ready and can email the file to Kindle.
                </p>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Folder path</span>
                  <input
                    type="text"
                    className={styles.textInput}
                    value={watchDirectoryDraft}
                    onChange={(event) => setWatchDirectoryDraft(event.target.value)}
                    placeholder="C:\\Books\\Ready for Kindle"
                  />
                </label>
                <p className={styles.systemNote}>
                  {deliverySettings?.watchDirectoryMessage ??
                    "Choose a watched folder to enable automatic matching."}
                </p>
                <p className={styles.systemNote}>
                  {deliverySettings?.smtpMessage ??
                    "Add SMTP details to enable Kindle delivery."}
                </p>
                {deliverySettings?.worker.expected ? (
                  <p className={styles.systemNote}>{deliverySettings.worker.message}</p>
                ) : null}
                <button type="submit" className={styles.primaryButton} disabled={settingsSaving}>
                  {settingsSaving ? "Saving..." : "Save watched folder"}
                </button>
              </form>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
