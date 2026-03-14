"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "@/app/unlock/unlock.module.css";

type UnlockScreenProps = {
  nextPath: string;
  isMobileCompatibilityMode?: boolean;
};

export function UnlockScreen({
  nextPath,
  isMobileCompatibilityMode = false,
}: UnlockScreenProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageClassName = isMobileCompatibilityMode
    ? `${styles.page} ${styles.pageMobile}`
    : styles.page;

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
      });

      const payload = (await response.json().catch(() => null)) as
        | { configured?: boolean; authenticated?: boolean }
        | null;

      if (payload?.authenticated || payload?.configured === false) {
        router.replace(nextPath);
      }
    })();
  }, [nextPath, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.message ?? "Kindling could not unlock right now.");
      }

      router.replace(nextPath);
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Kindling could not unlock right now.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={pageClassName}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>Household access</p>
        <h1>Unlock Kindling</h1>
        <p className={styles.copy}>
          Enter the household password before changing requests, profiles, or delivery settings.
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={styles.input}
              autoFocus
            />
          </label>

          {error ? <p className={styles.error}>{error}</p> : null}

          <button type="submit" className={styles.button} disabled={submitting}>
            {submitting ? "Unlocking..." : "Unlock"}
          </button>
        </form>

        <Link href="/" className={styles.link}>
          Back to Kindling
        </Link>
      </section>
    </main>
  );
}
