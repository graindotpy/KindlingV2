"use client";

import { useState } from "react";
import styles from "@/components/kindling-screen.module.css";
import { fetchJson } from "@/components/client-api";
import { Icon } from "@/components/icons";
import type { DeliverySettings } from "@/lib/delivery/types";
import type { HealthResponse, LocalUser } from "@/lib/requests/types";

type ProfileDraft = { name: string; kindleEmail: string };
const draftFor = (user: LocalUser): ProfileDraft => ({ name: user.name, kindleEmail: user.kindleEmail ?? "" });
const sorted = (users: LocalUser[]) => [...users].sort((a, b) => a.name.localeCompare(b.name));

function ProfileFields({ draft, onChange, creating }: { draft: ProfileDraft; onChange: (draft: ProfileDraft) => void; creating?: boolean }) {
  return <div className={styles.formGrid}>
    <label className={styles.field}><span className={styles.fieldLabel}>Name</span><input className={styles.textInput} value={draft.name} required maxLength={80} autoComplete="off" placeholder={creating ? "e.g. Alex" : undefined} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
    <label className={styles.field}><span className={styles.fieldLabel}>Kindle email <span className={styles.optionalLabel}>(optional)</span></span><input className={styles.textInput} type="email" value={draft.kindleEmail} maxLength={254} placeholder="name@kindle.com" autoComplete="off" onChange={(event) => onChange({ ...draft, kindleEmail: event.target.value })} /></label>
  </div>;
}

function ProfileEditor({ user, count, onSaved, onDeleted }: { user: LocalUser; count: number; onSaved: (user: LocalUser) => void; onDeleted: (user: LocalUser) => void }) {
  const [draft, setDraft] = useState(() => draftFor(user));
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canDelete = count > 1 && user.requestCount === 0;
  const changed = draft.name.trim() !== user.name || draft.kindleEmail.trim() !== (user.kindleEmail ?? "");

  async function save() {
    setBusy("save"); setError(null); setMessage(null);
    try {
      const updated = await fetchJson<LocalUser>(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify(draft) });
      setDraft(draftFor(updated)); onSaved(updated); setMessage("Profile saved.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save this profile."); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!window.confirm(`Remove ${user.name}'s household profile?`)) return;
    setBusy("delete"); setError(null); setMessage(null);
    try { onDeleted(await fetchJson<LocalUser>(`/api/users/${user.id}`, { method: "DELETE" })); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not remove this profile."); }
    finally { setBusy(null); }
  }

  return <form className={styles.profileCard} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <ProfileFields draft={draft} onChange={setDraft} />
    {error ? <p role="alert" className={styles.errorBanner}>{error}</p> : null}
    {message ? <p role="status" className={styles.successBanner}>{message}</p> : null}
    <div className={styles.actionRow}><button className={styles.secondaryButton} type="submit" disabled={Boolean(busy) || !changed}>{busy === "save" ? "Saving…" : "Save profile"}</button><button className={styles.dangerButton} type="button" disabled={Boolean(busy) || !canDelete} onClick={() => void remove()}>{busy === "delete" ? "Removing…" : "Remove profile"}</button></div>
    {!canDelete ? <p className={styles.systemNote}>{user.requestCount > 0 ? `${user.requestCount} saved request${user.requestCount === 1 ? " is" : "s are"} attached to this profile. Profiles with request history cannot be removed.` : "Keep at least one household profile."}</p> : null}
  </form>;
}

export function HouseholdSettings({ users, onUsersChange, onSelectUser, deliverySettings, onDeliverySettingsChange }: {
  users: LocalUser[];
  onUsersChange: (users: LocalUser[]) => void;
  onSelectUser: (id: number) => void;
  deliverySettings: DeliverySettings | null;
  onDeliverySettingsChange: (settings: DeliverySettings) => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>({ name: "", kindleEmail: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [watchDirectoryDraft, setWatchDirectoryDraft] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  async function createProfile() {
    setCreating(true); setError(null); setMessage(null);
    try {
      const created = await fetchJson<LocalUser>("/api/users", { method: "POST", body: JSON.stringify(draft) });
      onUsersChange(sorted([...users, created])); onSelectUser(created.id); setDraft({ name: "", kindleEmail: "" }); setMessage(`${created.name} has been added to your household.`);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not add this profile."); }
    finally { setCreating(false); }
  }

  async function saveDelivery() {
    setSettingsSaving(true); setSettingsError(null); setSettingsMessage(null);
    try {
      const settings = await fetchJson<DeliverySettings>("/api/settings/delivery", { method: "PUT", body: JSON.stringify({ watchDirectory: watchDirectoryDraft ?? deliverySettings?.watchDirectory ?? "" }) });
      onDeliverySettingsChange(settings); setWatchDirectoryDraft(null); setSettingsMessage(settings.watchDirectory ? settings.watchDirectoryMessage : "Kindle delivery folder cleared.");
    } catch (error) { setSettingsError(error instanceof Error ? error.message : "Could not save the delivery folder."); }
    finally { setSettingsSaving(false); }
  }

  async function checkConnections() {
    setChecking(true); setHealthError(null);
    try { setHealth(await fetchJson<HealthResponse>("/api/health")); }
    catch (error) { setHealthError(error instanceof Error ? error.message : "Could not check the connections."); }
    finally { setChecking(false); }
  }

  return <details className={styles.settingsDisclosure}>
    <summary><span className={styles.settingsSummary}><Icon name="settings" /><span>Household settings<small>Profiles, Kindle delivery and connections</small></span></span></summary>
    <div className={styles.settingsGrid}>
      <section className={styles.settingsPane} aria-labelledby="profiles-heading">
        <h3 id="profiles-heading">Your household</h3><p className={styles.cardMessage}>Give everyone their own book list. Add a Kindle email if they would like books delivered.</p>
        <div className={styles.profileList}>
          {users.map((user) => <ProfileEditor key={user.id} user={user} count={users.length} onSaved={(updated) => onUsersChange(sorted(users.map((entry) => entry.id === updated.id ? updated : entry)))} onDeleted={(deleted) => onUsersChange(users.filter((entry) => entry.id !== deleted.id))} />)}
          <form className={styles.profileCard} onSubmit={(event) => { event.preventDefault(); void createProfile(); }}>
            <h4>Add a person</h4><ProfileFields draft={draft} onChange={setDraft} creating />
            {error ? <p role="alert" className={styles.errorBanner}>{error}</p> : null}{message ? <p role="status" className={styles.successBanner}>{message}</p> : null}
            <button type="submit" className={styles.primaryButton} disabled={creating}>{creating ? "Adding…" : "Add to household"}</button>
          </form>
        </div>
      </section>
      <div className={styles.settingsColumn}>
        <form className={styles.settingsPane} onSubmit={(event) => { event.preventDefault(); void saveDelivery(); }}>
          <h3>Kindle delivery</h3><p className={styles.cardMessage}>Kindling looks for ebooks in this folder and its subfolders, then sends them to the requester’s Kindle when email delivery is configured.</p>
          <label className={styles.field}><span className={styles.fieldLabel}>Delivery folder</span><input className={styles.textInput} value={watchDirectoryDraft ?? deliverySettings?.watchDirectory ?? ""} onChange={(event) => setWatchDirectoryDraft(event.target.value)} placeholder="/books" spellCheck={false} autoComplete="off" /></label>
          <p className={styles.systemNote}>Use the folder path inside the Kindling container, such as /books.</p>
          {deliverySettings ? <div className={styles.connectionNotes}><p>{deliverySettings.watchDirectoryMessage}</p><p>{deliverySettings.smtpMessage}</p>{deliverySettings.worker.expected ? <p>{deliverySettings.worker.message}</p> : null}</div> : <p className={styles.systemNote}>Delivery settings are loading.</p>}
          {settingsError ? <p role="alert" className={styles.errorBanner}>{settingsError}</p> : null}{settingsMessage ? <p role="status" className={styles.successBanner}>{settingsMessage}</p> : null}
          <button type="submit" className={styles.secondaryButton} disabled={settingsSaving || watchDirectoryDraft === null}>{settingsSaving ? "Saving…" : "Save delivery folder"}</button>
        </form>
        <section className={styles.settingsPane} aria-labelledby="connections-heading">
          <h3 id="connections-heading">Library connections</h3><p className={styles.cardMessage}>Check that Kindling can reach your ebook and audiobook libraries.</p>
          <button type="button" className={styles.secondaryButton} onClick={() => void checkConnections()} disabled={checking}><Icon name="refresh" />{checking ? "Checking…" : "Check connections"}</button>
          {healthError ? <p role="alert" className={styles.errorBanner}>{healthError}</p> : null}
          {health ? <div className={styles.connectionNotes} role="status">{[{ label: "Ebook library", value: health.readarr }, { label: "Audiobook library", value: health.audiobookReadarr }].map(({ label, value }) => <div key={label}><strong>{label}: {value.reachable ? "Connected" : value.configured ? "Needs attention" : "Not set up"}</strong><p>{value.message}</p></div>)}<p>{health.worker.message}</p></div> : null}
        </section>
      </div>
    </div>
  </details>;
}
