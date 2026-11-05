"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "@/components/kindling-screen.module.css";
import { fetchJson } from "@/components/client-api";
import { EmptyState, FORMAT_LABELS, RequestCard, SearchResultCard, SkeletonCards } from "@/components/book-cards";
import { HouseholdSettings } from "@/components/household-settings";
import { Icon } from "@/components/icons";
import type { DeliverySettings, SendToKindleResult } from "@/lib/delivery/types";
import { matchesRequestFilter } from "@/lib/requests/status";
import type { BookRequestFilter, BookRequestFormat, BookRequestRecord, DetailedSearchResponse, LocalUser, SearchCandidate, SearchResultItem } from "@/lib/requests/types";

type SearchResponse = DetailedSearchResponse | { results: SearchResultItem[]; warnings: string[] };
const FILTERS: Array<{ key: BookRequestFilter; label: string }> = [{ key: "all", label: "All books" }, { key: "active", label: "On the way" }, { key: "available", label: "Ready" }];

export function KindlingScreen({ screen }: { screen: "books" | "request" | "requested" }) {
  const isSearch = screen === "request";
  const isHousehold = screen === "requested";
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [requests, setRequests] = useState<BookRequestRecord[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(!isSearch);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestsMessage, setRequestsMessage] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<BookRequestFilter>("all");
  const [busyRequests, setBusyRequests] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchCandidates, setSearchCandidates] = useState<SearchCandidate[]>([]);
  const [selectedCandidateKey, setSelectedCandidateKey] = useState("");
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [lastSearchedQuery, setLastSearchedQuery] = useState("");
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set());
  const [deliverySettings, setDeliverySettings] = useState<DeliverySettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [deliveryTargets, setDeliveryTargets] = useState<Record<number, number>>({});
  const searchSequence = useRef(0);
  const listSequence = useRef(0);
  const usersSequence = useRef(0);
  const settingsSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const selectedUserRef = useRef<number | null>(null);
  const busyActionRef = useRef(new Set<string>());
  const busyRequestRef = useRef(new Set<string>());
  const invalidateRequestList = useCallback(() => { ++listSequence.current; }, []);
  const invalidateInitialLoads = useCallback(() => { ++usersSequence.current; ++settingsSequence.current; }, []);
  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const filteredRequests = requests.filter((request) => matchesRequestFilter(request.status, activeFilter));

  const loadUsers = useCallback(async () => {
    const sequence = ++usersSequence.current;
    setUsersLoading(true); setUsersError(null);
    try {
      const data = await fetchJson<LocalUser[]>("/api/users");
      if (sequence !== usersSequence.current) return;
      setUsersError(null);
      setUsers(data);
      let savedId: number | null = null;
      try { savedId = Number(window.localStorage.getItem("kindling:selected-user")); } catch { /* Profiles also work when browser storage is unavailable. */ }
      const nextId = data.find((user) => user.id === selectedUserRef.current)?.id ?? data.find((user) => user.id === savedId)?.id ?? data[0]?.id ?? null;
      selectedUserRef.current = nextId; setSelectedUserId(nextId);
    } catch (error) { if (sequence === usersSequence.current) setUsersError(error instanceof Error ? error.message : "We could not load your household."); }
    finally { if (sequence === usersSequence.current) setUsersLoading(false); }
  }, []);

  const loadDeliverySettings = useCallback(async () => {
    const sequence = ++settingsSequence.current;
    setSettingsError(null);
    try {
      const settings = await fetchJson<DeliverySettings>("/api/settings/delivery");
      if (sequence === settingsSequence.current) { setDeliverySettings(settings); setSettingsError(null); }
    }
    catch (error) { if (sequence === settingsSequence.current) setSettingsError(error instanceof Error ? error.message : "Kindle delivery settings could not be loaded."); }
  }, []);

  const refreshRequests = useCallback(async (silent = false) => {
    if (isSearch || (!isHousehold && !selectedUserId)) return;
    if (silent && busyRequestRef.current.size > 0) return;
    const sequence = ++listSequence.current;
    if (!silent) setRequestsLoading(true);
    setRequestsError(null);
    try {
      const data = await fetchJson<BookRequestRecord[]>(isHousehold ? "/api/requests/all" : `/api/requests?userId=${selectedUserId}`);
      if (sequence === listSequence.current) setRequests(data);
    } catch (error) {
      if (sequence === listSequence.current) setRequestsError(error instanceof Error ? error.message : "We could not load the book list.");
    } finally { if (sequence === listSequence.current) setRequestsLoading(false); }
  }, [isHousehold, isSearch, selectedUserId]);

  useEffect(() => { void loadUsers(); }, [loadUsers]);
  useEffect(() => { if (!isSearch) void loadDeliverySettings(); }, [isSearch, loadDeliverySettings]);
  useEffect(() => invalidateInitialLoads, [invalidateInitialLoads]);
  useEffect(() => {
    void refreshRequests();
    if (isSearch) return;
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refreshRequests(true); }, 45000);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshRequests(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); invalidateRequestList(); };
  }, [invalidateRequestList, isSearch, refreshRequests]);
  useEffect(() => () => { searchController.current?.abort(); ++searchSequence.current; }, []);

  function clearSearch() {
    searchController.current?.abort(); ++searchSequence.current;
    setSearchLoading(false); setSearchError(null); setSearchWarnings([]); setSearchResults([]); setSearchCandidates([]); setSelectedCandidateKey(""); setLastSearchedQuery(""); setSearchMessage(null);
  }

  function selectUser(id: number) {
    if (id === selectedUserRef.current) return;
    selectedUserRef.current = id;
    ++listSequence.current;
    setSelectedUserId(id); setRequests([]); setRequestsError(null); setRequestsMessage(null); setActiveFilter("all");
    if (!isSearch) setRequestsLoading(true);
    clearSearch();
    try { window.localStorage.setItem("kindling:selected-user", String(id)); } catch { /* Browser storage is optional. */ }
  }

  function updateUsers(nextUsers: LocalUser[]) {
    setUsers(nextUsers);
    if (!nextUsers.some((user) => user.id === selectedUserRef.current) && nextUsers[0]) selectUser(nextUsers[0].id);
  }

  async function search(candidateKey?: string) {
    const query = searchQuery.trim();
    if (!selectedUserId) return;
    if (query.length < 2) { setSearchError("Enter at least two letters of a title or author, or an ISBN."); return; }
    if (candidateKey !== undefined && !candidateKey) return;
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    const sequence = ++searchSequence.current;
    if (candidateKey === undefined) { setSearchCandidates([]); setSelectedCandidateKey(""); }
    setSearchLoading(true); setSearchError(null); setSearchMessage(null); setSearchWarnings([]);
    try {
      const candidateQuery = candidateKey === undefined ? "" : `&candidate=${encodeURIComponent(candidateKey)}`;
      const data = await fetchJson<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}&userId=${selectedUserId}&details=1${candidateQuery}`, { signal: controller.signal });
      if (sequence !== searchSequence.current) return;
      setSearchWarnings(data.warnings ?? []); setLastSearchedQuery(query);
      if ("state" in data && data.state === "choose") {
        setSearchCandidates(data.candidates); setSelectedCandidateKey(""); setSearchResults([]);
      } else {
        setSearchCandidates([]); setSelectedCandidateKey(""); setSearchResults(data.results);
      }
    } catch (error) {
      if (sequence !== searchSequence.current || controller.signal.aborted) return;
      setSearchError(error instanceof Error ? error.message : "Search is unavailable. Please try again."); setSearchResults([]); setLastSearchedQuery("");
    } finally { if (sequence === searchSequence.current) setSearchLoading(false); }
  }

  async function handleRequest(result: SearchResultItem, format: BookRequestFormat) {
    const action = result.actions[format];
    const userId = selectedUserId;
    if (!userId || action.availability !== "requestable" || !action.source) return;
    const key = `${result.fingerprint}:${format}`;
    if (busyActionRef.current.has(key)) return;
    busyActionRef.current.add(key); setBusyActions(new Set(busyActionRef.current)); setSearchError(null); setSearchMessage(null);
    try {
      const created = await fetchJson<BookRequestRecord>("/api/requests", { method: "POST", body: JSON.stringify({ userId, requestFormat: format, selection: action.source }) });
      if (selectedUserRef.current !== userId) return;
      setSearchResults((entries) => entries.map((entry) => entry.fingerprint === result.fingerprint ? { ...entry, actions: { ...entry.actions, [format]: { ...entry.actions[format], availability: "requested-by-you", availabilityLabel: "Requested", availabilityDescription: created.statusMessage ?? "You can follow its progress in My books.", request: created } } } : entry));
      setSearchMessage(`${result.title} (${FORMAT_LABELS[format].toLowerCase()}) was added to your books.${created.status === "failed" ? " It needs attention; check its status in My books." : ""}`);
    } catch (error) { if (selectedUserRef.current === userId) setSearchError(error instanceof Error ? error.message : "Could not request this book."); }
    finally { busyActionRef.current.delete(key); setBusyActions(new Set(busyActionRef.current)); }
  }

  async function requestAction(request: BookRequestRecord, action: "sync" | "remove" | "send") {
    const key = `${request.id}:${action}`;
    if ([...busyRequestRef.current].some((item) => item.startsWith(`${request.id}:`))) return;
    const userId = selectedUserRef.current;
    busyRequestRef.current.add(key); setBusyRequests(new Set(busyRequestRef.current)); setRequestsError(null); setRequestsMessage(null);
    // Invalidate a list fetch that began before this mutation, so it cannot undo the result.
    ++listSequence.current;
    try {
      if (action === "send") {
        const result = await fetchJson<SendToKindleResult>(`/api/requests/${request.id}/deliver`, { method: "POST", body: JSON.stringify({ recipientUserId: deliveryTargets[request.id] ?? request.userId }) });
        if (!isHousehold && selectedUserRef.current !== userId) return;
        setRequests((entries) => entries.map((entry) => entry.id === request.id ? result.request : entry));
        if (result.attempt.status === "failed") setRequestsError(result.attempt.message ?? "This book could not be sent to Kindle. Please try again.");
        else setRequestsMessage(result.attempt.message ?? "Book sent to Kindle.");
      } else {
        const updated = await fetchJson<BookRequestRecord>(`/api/requests/${request.id}${action === "sync" ? "/sync" : ""}`, { method: action === "sync" ? "POST" : "DELETE" });
        if (!isHousehold && selectedUserRef.current !== userId) return;
        setRequests((entries) => action === "remove" ? entries.filter((entry) => entry.id !== request.id) : entries.map((entry) => entry.id === request.id ? updated : entry));
        if (action === "remove") setUsers((entries) => entries.map((entry) => entry.id === request.userId ? { ...entry, requestCount: Math.max(0, entry.requestCount - 1) } : entry));
        setRequestsMessage(action === "remove" ? `${request.requestedTitle} was removed from the list. Your library files are kept.` : `${request.requestedTitle}: ${updated.statusMessage ?? "status checked."}`);
      }
    } catch (error) { if (isHousehold || selectedUserRef.current === userId) setRequestsError(error instanceof Error ? error.message : "Could not finish this action. Please try again."); }
    finally { busyRequestRef.current.delete(key); setBusyRequests(new Set(busyRequestRef.current)); if (isHousehold || selectedUserRef.current === userId) setRequestsLoading(false); }
  }

  const count = (filter: BookRequestFilter) => requests.filter((request) => matchesRequestFilter(request.status, filter)).length;
  return <div className={styles.page}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand} aria-label="Kindling home"><span className={styles.brandMark}><Icon name="book" /></span><span>kindling<span className={styles.brandDot}>.</span></span></Link>
        <nav className={styles.navTabs} aria-label="Main navigation">
          <Link href="/" aria-current={isSearch ? "page" : undefined} className={`${styles.navTab} ${isSearch ? styles.navTabActive : ""}`}><Icon name="search" /><span>Find a book</span></Link>
          <Link href="/books" aria-current={screen === "books" ? "page" : undefined} className={`${styles.navTab} ${screen === "books" ? styles.navTabActive : ""}`}><Icon name="book" /><span>My books</span></Link>
          <Link href="/requested" aria-current={isHousehold ? "page" : undefined} className={`${styles.navTab} ${isHousehold ? styles.navTabActive : ""}`}><Icon name="people" /><span>Household</span></Link>
        </nav>
        <label className={styles.profileSelect}><span>Browsing as</span><select aria-label="Choose your household profile" value={selectedUserId ?? ""} disabled={usersLoading || users.length === 0} onChange={(event) => selectUser(Number(event.target.value))}>{users.length === 0 ? <option value="">{usersLoading ? "Loading…" : "No profile"}</option> : users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
      </div>
    </header>

    <main id="main-content" className={styles.main}>
      <section className={`${styles.hero} ${isSearch ? styles.searchHero : ""}`}>
        <div><p className={styles.eyebrow}>{isSearch ? "A little something for your next chapter" : isHousehold ? "Better together" : "Your reading corner"}</p><h1>{isSearch ? <>Find your next<br /><em>great read.</em></> : isHousehold ? "The household bookshelf." : selectedUser ? `${selectedUser.name}’s books.` : "Your books."}</h1><p className={styles.heroText}>{isSearch ? "A book to get lost in. A story to take along. Find it here, and we’ll put the request in for you." : isHousehold ? "See what everyone’s reading and what’s on the way." : "Everything you’ve requested, with its latest progress in one place."}</p></div>
        {isSearch ? <div className={styles.heroArtwork} aria-hidden="true"><span className={styles.artSpark}>✦</span><div className={`${styles.artBook} ${styles.artBookBack}`}><span>ONE MORE<br />CHAPTER</span><i /></div><div className={`${styles.artBook} ${styles.artBookFront}`}><Icon name="book" /><span>GOOD<br />STORIES<br /><em>await.</em></span><i /></div><span className={styles.artCaption}>EBOOKS & AUDIOBOOKS</span></div> : <Link href="/" className={styles.primaryButton}><Icon name="search" />Find a book</Link>}
      </section>

      {usersError ? <div className={styles.errorBanner} role="alert"><p>{usersError}</p><button type="button" className={styles.secondaryButton} onClick={() => void loadUsers()}>Try again</button></div> : null}
      {!usersLoading && users.length === 0 && !usersError ? <EmptyState title="Let’s add your first reader" body="Open Household settings below to create a profile and start requesting books." actionHref={isHousehold ? undefined : "/requested"} actionLabel={isHousehold ? undefined : "Set up household"} icon="people" /> : null}

      {isSearch ? <section className={styles.searchSection} aria-label="Book search">
        <form className={styles.searchForm} onSubmit={(event) => { event.preventDefault(); void search(); }} role="search">
          <label htmlFor="book-search" className={styles.searchLabel}>What would you like to read or listen to?</label>
          <div className={styles.searchBar}><Icon name="search" /><input id="book-search" type="search" className={styles.searchInput} placeholder="Search a title, author or ISBN" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); clearSearch(); }} maxLength={200} autoComplete="off" enterKeyHint="search" aria-describedby="search-hint" disabled={usersLoading || !selectedUser} /><button type="submit" className={styles.primaryButton} disabled={searchLoading || usersLoading || !selectedUser || searchQuery.trim().length < 2}>{searchLoading ? "Searching…" : "Find a book"}<Icon name="arrow" /></button></div>
          <p id="search-hint" className={styles.searchHint}>Find the right title, then choose ebook or audiobook. We’ll take it from there.</p>
        </form>
        {searchError ? <p className={styles.errorBanner} role="alert">{searchError}</p> : null}
        {searchWarnings.length > 0 ? <div className={styles.warningBanner} role="status">{searchWarnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
        {searchMessage ? <div className={styles.successBanner} role="status"><Icon name="check" /><p>{searchMessage} <Link href="/books">View my books →</Link></p></div> : null}
        {searchLoading ? <><p className={styles.resultsHeading} role="status">Looking for “{searchQuery.trim()}”…</p><SkeletonCards /></> : searchCandidates.length > 0 ? <div className={styles.disambiguation} role="group" aria-labelledby="search-disambiguation-heading" aria-describedby="search-disambiguation-description">
          <div className={styles.disambiguationIntro}><p className={styles.disambiguationEyebrow}>A few books share that title</p><h2 id="search-disambiguation-heading">Did you mean…</h2><p id="search-disambiguation-description">Choose the title and author you had in mind, then we’ll find the matching editions.</p></div>
          <div className={styles.candidateControls}>
            <label className={styles.candidateField} htmlFor="book-candidate"><span>Choose the book</span><select id="book-candidate" className={styles.candidateSelect} value={selectedCandidateKey} onChange={(event) => setSelectedCandidateKey(event.target.value)}><option value="">Select a title and author</option>{searchCandidates.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.title} — {candidate.author}{candidate.year ? ` (${candidate.year})` : ""}</option>)}</select></label>
            <button type="button" className={styles.primaryButton} disabled={!selectedCandidateKey} onClick={() => void search(selectedCandidateKey)}>Continue<Icon name="arrow" /></button>
          </div>
        </div> : lastSearchedQuery ? <>
          <div className={styles.resultsHeading} role="status"><h2>{searchResults.length} {searchResults.length === 1 ? "match" : "matches"} for “{lastSearchedQuery}”</h2><span>Choose your format below</span></div>
          {searchResults.length > 0 ? <div className={styles.cardGrid}>{searchResults.map((result) => <SearchResultCard key={result.fingerprint} result={result} busyKeys={busyActions} onRequest={(entry, format) => void handleRequest(entry, format)} />)}</div> : <EmptyState icon="search" title="We couldn’t find that one" body="Try a shorter title, just the author’s name, or an ISBN. Check the spelling and search again." />}
        </> : !searchError ? <div className={styles.howItWorks}><div><span>01</span><h3>Find your story</h3><p>Search for a title or a favourite author.</p></div><div><span>02</span><h3>Make it yours</h3><p>Choose an ebook or an audiobook.</p></div><div><span>03</span><h3>We’ll take it from here</h3><p>Follow your request’s progress in My books.</p></div></div> : null}
      </section> : <section className={styles.listSection} aria-label={isHousehold ? "Household requests" : "Your requests"}>
        <div className={styles.listToolbar}><div className={styles.filterRow} aria-label="Filter books">{FILTERS.map((filter) => <button key={filter.key} type="button" aria-pressed={activeFilter === filter.key} className={`${styles.filterChip} ${activeFilter === filter.key ? styles.filterChipActive : ""}`} onClick={() => setActiveFilter(filter.key)}>{filter.label}<span>{count(filter.key)}</span></button>)}</div><button type="button" className={styles.refreshButton} disabled={requestsLoading || usersLoading || busyRequests.size > 0 || (!isHousehold && !selectedUser)} onClick={() => void refreshRequests()}><Icon name="refresh" />{requestsLoading ? "Refreshing…" : "Refresh"}</button></div>
        <p className={styles.listHint}>Progress updates automatically while you’re here.</p>
        {requestsError ? <div role="alert" className={styles.errorBanner}><p>{requestsError}</p><button type="button" className={styles.secondaryButton} onClick={() => void refreshRequests()}>Try again</button></div> : null}
        {requestsMessage ? <p role="status" className={styles.successBanner}>{requestsMessage}</p> : null}
        {settingsError ? <div className={styles.warningBanner} role="status"><p>{settingsError}</p><button type="button" className={styles.secondaryButton} onClick={() => void loadDeliverySettings()}>Retry delivery settings</button></div> : null}
        {usersLoading || (requestsLoading && !usersError && (isHousehold || selectedUserId !== null)) ? <SkeletonCards /> : filteredRequests.length > 0 ? <div className={styles.cardGrid}>{filteredRequests.map((request) => <RequestCard key={request.id} request={request} syncing={busyRequests.has(`${request.id}:sync`)} clearing={busyRequests.has(`${request.id}:remove`)} sending={busyRequests.has(`${request.id}:send`)} showRequester={isHousehold} onSync={() => void requestAction(request, "sync")} onClear={() => void requestAction(request, "remove")} deliveryUsers={users} smtpConfigured={deliverySettings?.smtpConfigured} smtpMessage={deliverySettings?.smtpMessage} selectedRecipientId={deliveryTargets[request.id] ?? request.userId} onRecipientChange={(requestId, userId) => setDeliveryTargets((current) => ({ ...current, [requestId]: userId }))} onSendToKindle={() => void requestAction(request, "send")} />)}</div> : !requestsError && !usersError && users.length > 0 ? <EmptyState title={activeFilter === "available" ? "No books ready just yet" : activeFilter === "active" ? "Nothing on the way" : "Your next chapter starts here"} body={activeFilter === "available" ? "Your books will appear here when they’re available. Check All books to see their progress." : activeFilter === "active" ? "There are no requests in progress. Find something new for your bookshelf." : "Request your first ebook or audiobook and we’ll keep track of it here."} actionLabel="Find a book" actionHref="/" /> : null}
      </section>}
      {isHousehold ? <HouseholdSettings users={users} onUsersChange={updateUsers} onSelectUser={selectUser} deliverySettings={deliverySettings} onDeliverySettingsChange={setDeliverySettings} /> : null}
      <footer className={styles.footer}><span>kindling.</span><p>A home for your next good story.</p></footer>
    </main>
  </div>;
}
