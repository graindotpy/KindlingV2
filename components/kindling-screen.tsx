/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import styles from "@/components/kindling-screen.module.css";
import { BOOK_REQUEST_STATUS_LABELS, matchesRequestFilter } from "@/lib/requests/status";
import type {
  BookRequestFilter,
  BookRequestRecord,
  LocalUser,
  SearchResultItem,
} from "@/lib/requests/types";

type KindlingScreenProps = {
  screen: "books" | "request" | "requested";
};

const FILTERS: Array<{ key: BookRequestFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "available", label: "Available" },
];

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

function statusTone(status: BookRequestRecord["status"]) {
  switch (status) {
    case "available":
      return styles.statusAvailable;
    case "downloading":
      return styles.statusDownloading;
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

function SkeletonCards() {
  return (
    <div className={styles.cardGrid}>
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
  onSync: (requestId: number) => void;
  showRequester?: boolean;
}) {
  return (
    <article className={styles.card}>
      <Cover title={props.request.requestedTitle} imageUrl={props.request.coverUrl} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <div>
            <h3>{props.request.requestedTitle}</h3>
            <p className={styles.subtleText}>{props.request.requestedAuthor}</p>
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
        </dl>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => props.onSync(props.request.id)}
          disabled={props.syncing}
        >
          {props.syncing ? "Refreshing..." : "Refresh status"}
        </button>
      </div>
    </article>
  );
}

function SearchResultCard(props: {
  result: SearchResultItem;
  busy: boolean;
  onRequest: (result: SearchResultItem) => void;
}) {
  const isRequestable = props.result.availability === "requestable";

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
          <span
            className={`${styles.statusPill} ${
              isRequestable ? styles.statusRequested : styles.statusSearching
            }`}
          >
            {props.result.availabilityLabel}
          </span>
        </div>
        <p className={styles.cardMessage}>{props.result.availabilityDescription}</p>
        {isRequestable ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => props.onRequest(props.result)}
            disabled={props.busy}
          >
            {props.busy ? "Requesting..." : "Request book"}
          </button>
        ) : props.result.availability === "requested-by-you" ? (
          <Link href="/" className={styles.secondaryButton}>
            View in My Books
          </Link>
        ) : props.result.availability === "already-requested" ? (
          <Link href="/requested" className={styles.secondaryButton}>
            View all requests
          </Link>
        ) : (
          <div className={styles.systemNote}>No extra step needed for this one.</div>
        )}
      </div>
    </article>
  );
}

export function KindlingScreen({ screen }: KindlingScreenProps) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [requests, setRequests] = useState<BookRequestRecord[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(screen !== "request");
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<BookRequestFilter>("all");
  const [syncingRequestId, setSyncingRequestId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [requestingFingerprint, setRequestingFingerprint] = useState<string | null>(null);
  const [lastSearchedQuery, setLastSearchedQuery] = useState("");
  const activeSearchQueryRef = useRef<string | null>(null);
  const isHouseholdScreen = screen === "requested";
  const isRequestListScreen = screen !== "request";

  const filteredRequests = requests.filter((request) =>
    matchesRequestFilter(request.status, activeFilter),
  );

  const refreshRequests = useCallback(
    async (silent = false) => {
      if (!isHouseholdScreen && !selectedUserId) {
        return;
      }

      if (!silent) {
        setRequestsLoading(true);
      }

      setRequestsError(null);

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
        setSearchError("Please enter a title or author.");
        setSearchResults([]);
        setLastSearchedQuery("");
        activeSearchQueryRef.current = null;
        return;
      }

      activeSearchQueryRef.current = trimmedQuery;
      setSearchLoading(true);
      setSearchError(null);

      try {
        const encodedQuery = encodeURIComponent(trimmedQuery);
        const data = await fetchJson<SearchResultItem[]>(
          `/api/search?q=${encodedQuery}&userId=${selectedUserId}`,
        );
        setSearchResults(data);
        setLastSearchedQuery(trimmedQuery);
      } catch (error) {
        setSearchError(error instanceof Error ? error.message : "Search is unavailable.");
        setSearchResults([]);
      } finally {
        activeSearchQueryRef.current = null;
        setSearchLoading(false);
      }
    },
    [selectedUserId],
  );

  const maybeRunSearch = useCallback(async () => {
    const trimmedQuery = searchQuery.trim();

    if (!trimmedQuery) {
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
  }, [lastSearchedQuery, performSearch, searchQuery]);

  useEffect(() => {
    void (async () => {
      const data = await fetchJson<LocalUser[]>("/api/users");
      setUsers(data);

      const savedUserId = Number(window.localStorage.getItem("kindling:selected-user"));
      const nextUserId =
        data.find((user) => user.id === savedUserId)?.id ?? data[0]?.id ?? null;
      setSelectedUserId(nextUserId);
    })().catch((error: unknown) => {
      setRequestsError(
        error instanceof Error ? error.message : "We could not load the family list.",
      );
    });
  }, []);

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
    setSearchResults([]);
    setSearchError(null);
    setLastSearchedQuery("");
    activeSearchQueryRef.current = null;
  }, [selectedUserId]);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const canRenderRequestSection = isHouseholdScreen || Boolean(selectedUser);

  const counts = {
    all: requests.length,
    active: requests.filter((request) => matchesRequestFilter(request.status, "active")).length,
    available: requests.filter((request) =>
      matchesRequestFilter(request.status, "available"),
    ).length,
  };

  async function handleRequest(result: SearchResultItem) {
    if (!selectedUserId) {
      return;
    }

    setRequestingFingerprint(result.fingerprint);
    setSearchError(null);

    try {
      const created = await fetchJson<BookRequestRecord>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          userId: selectedUserId,
          selection: result.source,
        }),
      });

      setSearchResults((current) =>
        current.map((entry) =>
          entry.fingerprint === result.fingerprint
            ? {
                ...entry,
                availability: "requested-by-you",
                availabilityLabel: "Already in My Books",
                availabilityDescription: created.statusMessage ?? "Saved in your list.",
                request: created,
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
      setRequestingFingerprint(null);
    }
  }

  async function handleSyncRequest(requestId: number) {
    setSyncingRequestId(requestId);
    setRequestsError(null);

    try {
      const updated = await fetchJson<BookRequestRecord>(`/api/requests/${requestId}/sync`, {
        method: "POST",
      });

      setRequests((current) =>
        current.map((request) => (request.id === updated.id ? updated : request)),
      );
    } catch (error) {
      setRequestsError(
        error instanceof Error ? error.message : "We could not refresh that request.",
      );
    } finally {
      setSyncingRequestId(null);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroBrand}>
          <img src="/kindling-mark.svg" alt="" className={styles.brandMark} />
          <div>
            <p className={styles.eyebrow}>Family book requests</p>
            <h1>Kindling</h1>
          </div>
        </div>
        <p className={styles.heroText}>
          {screen === "books"
            ? "A calm, simple list of the books your family has asked for."
            : screen === "request"
              ? "Search by title or author, then tap once to ask for a book."
              : "A full household view of every request Kindling has recorded."}
        </p>
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
                    ? "My Books"
                    : screen === "request"
                      ? "Request Book"
                      : "All Requests"}
                </p>
                <h2>
                  {screen === "books"
                    ? `${selectedUser?.name}'s requested books`
                    : screen === "request"
                      ? `Search for a book for ${selectedUser?.name}`
                      : "Everything the house has requested"}
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

                {requestsLoading ? (
                  <SkeletonCards />
                ) : filteredRequests.length > 0 ? (
                  <div className={styles.cardGrid}>
                    {filteredRequests.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        syncing={syncingRequestId === request.id}
                        onSync={handleSyncRequest}
                        showRequester={isHouseholdScreen}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={isHouseholdScreen ? "No requests yet" : "No books here yet"}
                    body={
                      isHouseholdScreen
                        ? "When someone requests a book, it will appear here with its latest status."
                        : "When you request a book, it will show up here with a clear status."
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
                        busy={requestingFingerprint === result.fingerprint}
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
                    body="Type the title or author you want, then choose the right match."
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
      </section>
    </main>
  );
}
