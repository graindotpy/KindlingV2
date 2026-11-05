"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import styles from "@/app/unlock/unlock.module.css";

type SessionStatus = { configured?: boolean; authenticated?: boolean; message?: string };

async function readSession(init?: RequestInit): Promise<SessionStatus> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  const cancel = () => controller.abort();
  init?.signal?.addEventListener("abort", cancel, { once: true });
  if (init?.signal?.aborted) controller.abort();

  try {
    const response = await fetch("/api/auth/session", {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as SessionStatus | null;
    if (!response.ok) throw new Error(payload?.message ?? "Kindling could not unlock right now. Please try again.");
    if (!payload) throw new Error("Kindling returned an empty response. Please try again.");
    return payload;
  } catch (error) {
    if (timedOut) throw new Error("Kindling is taking too long to respond. Please try again.");
    if (error instanceof TypeError) throw new Error("We could not reach Kindling. Check your connection and try again.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", cancel);
  }
}

export function UnlockScreen({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkVersion, setCheckVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void readSession({ signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      if (payload.authenticated) { router.replace(nextPath); router.refresh(); return; }
      setConfigured(payload.configured !== false);
    }).catch((checkError) => {
      if (!controller.signal.aborted) setError(checkError instanceof Error ? checkError.message : "We could not check your session. Please try again.");
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [checkVersion, nextPath, router]);

  function retryCheck() {
    setChecking(true); setError(null); setCheckVersion((version) => version + 1);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || checking || configured === false || !password) return;
    setSubmitting(true); setError(null);
    try {
      await readSession({ method: "POST", body: JSON.stringify({ password }) });
      router.replace(nextPath); router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Kindling could not unlock right now.");
    } finally { setSubmitting(false); }
  }

  return <main className={styles.page}>
    <Link href="/" className={styles.brand} aria-label="Kindling home"><span className={styles.brandMark}><Icon name="book" /></span><span>kindling<span className={styles.brandDot}>.</span></span></Link>
    <section className={styles.card} aria-labelledby="unlock-heading">
      <p className={styles.eyebrow}>Your household bookshelf</p>
      <h1 id="unlock-heading">{configured === false ? "A little setup first." : "Welcome back."}</h1>
      <p className={styles.copy}>{configured === false ? "Your household password has not been set up yet. Ask the person who looks after Kindling to finish its setup, then check again." : "Enter your household password to find your next good story."}</p>

      {checking ? <p className={styles.status} role="status">Checking household access…</p> : configured === false ? <div className={styles.setup}>
        <details><summary>Setup details</summary><p>Set <code>KINDLING_ADMIN_PASSWORD</code> and <code>KINDLING_SESSION_SECRET</code> in Kindling’s container settings, then restart the app.</p></details>
        <button type="button" className={styles.button} onClick={retryCheck}>Check again<Icon name="refresh" /></button>
      </div> : <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}><span>Household password</span><input type="password" name="password" value={password} onChange={(event) => setPassword(event.target.value)} className={styles.input} autoComplete="current-password" required maxLength={1024} autoFocus aria-describedby={error ? "unlock-error" : undefined} /></label>
        <button type="submit" className={styles.button} disabled={submitting || !password}>{submitting ? "Unlocking…" : "Unlock Kindling"}<Icon name="arrow" /></button>
      </form>}
      {error ? <p id="unlock-error" className={styles.error} role="alert">{error}</p> : null}
      {!checking && configured === null ? <button className={styles.linkButton} type="button" onClick={retryCheck}>Check connection again</button> : null}
      <p className={styles.note}>One password for everyone at home.</p>
    </section>
    <p className={styles.footer}>A home for your next good story.</p>
  </main>;
}
