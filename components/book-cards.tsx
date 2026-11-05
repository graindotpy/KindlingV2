/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "@/components/kindling-screen.module.css";
import { Icon } from "@/components/icons";
import { BOOK_REQUEST_STATUS_LABELS, supportsKindleDelivery } from "@/lib/requests/status";
import type { BookRequestFormat, BookRequestRecord, LocalUser, SearchResultItem } from "@/lib/requests/types";

export const FORMAT_LABELS: Record<BookRequestFormat, string> = { ebook: "Ebook", audiobook: "Audiobook" };
export const REQUEST_FORMATS: BookRequestFormat[] = ["ebook", "audiobook"];

function requestedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Recently" : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function EmptyState(props: { title: string; body: string; actionLabel?: string; actionHref?: string; icon?: "search" | "book" | "people" }) {
  return <div className={styles.emptyState}>
    <span className={styles.emptyIcon}><Icon name={props.icon ?? "book"} /></span>
    <h3>{props.title}</h3><p>{props.body}</p>
    {props.actionLabel && props.actionHref ? <Link href={props.actionHref} className={styles.primaryButton}>{props.actionLabel}<Icon name="arrow" /></Link> : null}
  </div>;
}

export function SkeletonCards() {
  return <div role="status" aria-label="Loading books"><span className="sr-only">Loading books…</span><div className={styles.cardGrid} aria-hidden="true">
    {[0, 1, 2, 3].map((item) => <div key={item} className={`${styles.card} ${styles.skeletonCard}`}><div className={styles.skeletonCover} /><div className={styles.cardBody}><div className={styles.skeletonLine} /><div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} /><div className={styles.skeletonLine} /></div></div>)}
  </div></div>;
}

function Cover({ title, imageUrl }: { title: string; imageUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (imageUrl && imageUrl !== failedUrl) return <img src={imageUrl} alt="" className={styles.cover} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl)} />;
  return <div className={styles.coverFallback} aria-hidden="true"><Icon name="book" /><span>{title}</span><span className={styles.coverRule} /></div>;
}

export function SearchResultCard({ result, busyKeys, onRequest }: {
  result: SearchResultItem;
  busyKeys: Set<string>;
  onRequest: (result: SearchResultItem, format: BookRequestFormat) => void;
}) {
  return <article className={`${styles.card} ${styles.searchResultCard}`}>
    <Cover title={result.title} imageUrl={result.coverUrl} />
    <div className={styles.cardBody}>
      <div><h3>{result.title}</h3><p className={styles.subtleText}>{result.author}{result.year ? ` · ${result.year}` : ""}</p></div>
      <div className={styles.requestOptionGrid}>
        {REQUEST_FORMATS.map((format) => {
          const action = result.actions[format];
          const canRequest = action.availability === "requestable";
          const busy = busyKeys.has(`${result.fingerprint}:${format}`);
          const saved = action.availability === "requested-by-you";
          const label = busy ? "Requesting…" : canRequest ? `Request ${FORMAT_LABELS[format].toLowerCase()}` : saved ? `${FORMAT_LABELS[format]} requested` : action.availability === "already-available" ? `${FORMAT_LABELS[format]} ready` : action.availability === "already-requested" ? `${FORMAT_LABELS[format]} requested` : `${FORMAT_LABELS[format]} unavailable`;
          return <div key={format} className={styles.requestOption}>
            <button type="button" className={canRequest ? styles.requestButton : styles.secondaryButton} disabled={busy || !canRequest} onClick={() => onRequest(result, format)} aria-label={`${label}: ${result.title}`} title={action.availabilityDescription}>
              <Icon name={saved ? "check" : format === "ebook" ? "book" : "headphones"} />{label}
            </button>
            {!canRequest ? <p className={styles.availabilityNote}>{action.availabilityDescription}</p> : null}
          </div>;
        })}
      </div>
    </div>
  </article>;
}

export function RequestCard(props: {
  request: BookRequestRecord;
  syncing: boolean;
  clearing: boolean;
  onSync: (id: number) => void;
  onClear: (id: number) => void;
  showRequester?: boolean;
  smtpConfigured?: boolean;
  smtpMessage?: string | null;
  deliveryUsers: LocalUser[];
  selectedRecipientId?: number;
  sending: boolean;
  onRecipientChange: (requestId: number, userId: number) => void;
  onSendToKindle: (requestId: number) => void;
}) {
  const request = props.request;
  const selectedRecipient = props.deliveryUsers.find((user) => user.id === props.selectedRecipientId);
  const canDeliver = supportsKindleDelivery(request.requestFormat);
  const canSend = Boolean(request.matchedFilePath && props.smtpConfigured && selectedRecipient?.kindleEmail);
  const busy = props.syncing || props.clearing || props.sending;
  const tones = { available: styles.statusAvailable, downloading: styles.statusDownloading, searching: styles.statusSearching, failed: styles.statusFailed, "not-monitored": styles.statusNotMonitored, requested: styles.statusRequested };

  return <article className={styles.card}>
    <Cover title={request.requestedTitle} imageUrl={request.coverUrl} />
    <div className={styles.cardBody}>
      <div><div className={styles.cardEyebrow}><Icon name={request.requestFormat === "ebook" ? "book" : "headphones"} />{FORMAT_LABELS[request.requestFormat]}<span className={`${styles.statusPill} ${tones[request.status]}`}>{BOOK_REQUEST_STATUS_LABELS[request.status]}</span></div><h3>{request.requestedTitle}</h3><p className={styles.subtleText}>{request.requestedAuthor}</p></div>
      <p className={styles.cardMessage}>{request.statusMessage ?? "Your request has been saved."}</p>
      <p className={styles.requestDate}>{props.showRequester ? `${request.userName} · ` : ""}{requestedDate(request.requestedAt)}</p>
      {request.status === "failed" ? <button type="button" className={styles.requestButton} onClick={() => props.onSync(request.id)} disabled={busy}><Icon name="refresh" />{props.syncing ? "Trying again…" : "Try again"}</button> : null}
      {canDeliver && request.status === "available" ? <details className={styles.deliveryDetails}>
        <summary>Send to Kindle</summary>
        <div className={styles.deliveryPanel}>
          <label className={styles.field}><span className={styles.fieldLabel}>Send to</span><select className={styles.selectInput} value={props.selectedRecipientId ?? ""} disabled={busy} onChange={(event) => props.onRecipientChange(request.id, Number(event.target.value))}>
            {props.deliveryUsers.map((user) => <option key={user.id} value={user.id}>{user.name}{user.kindleEmail ? "" : " (no Kindle email)"}</option>)}
          </select></label>
          <button type="button" className={styles.primaryButton} disabled={busy || !canSend} onClick={() => props.onSendToKindle(request.id)}>{props.sending ? "Sending…" : "Send book"}</button>
          <p className={styles.systemNote}>{!request.matchedFilePath ? "The book is ready in your library. Kindle delivery will be available when Kindling finds its file in the delivery folder." : !props.smtpConfigured ? props.smtpMessage ?? "Kindle delivery needs to be set up in Household settings." : !selectedRecipient?.kindleEmail ? "Add a Kindle email in Household settings to send this book." : `This book will be emailed to ${selectedRecipient.kindleEmail}.`}</p>
        </div>
      </details> : null}
      {request.lastDeliveryMessage ? <p className={styles.systemNote}>{request.lastDeliveryMessage}</p> : null}
      <details className={styles.requestDetails}>
        <summary>Manage request</summary>
        <div className={styles.actionRow}>
          {request.status !== "failed" ? <button type="button" className={styles.secondaryButton} onClick={() => props.onSync(request.id)} disabled={busy}><Icon name="refresh" />{props.syncing ? "Checking…" : "Check status"}</button> : null}
          <button type="button" className={styles.dangerButton} onClick={() => props.onClear(request.id)} disabled={busy}>{props.clearing ? "Removing…" : "Remove from list"}</button>
        </div>
        <p className={styles.systemNote}>Removing a request keeps the book in your library.</p>
      </details>
    </div>
  </article>;
}
