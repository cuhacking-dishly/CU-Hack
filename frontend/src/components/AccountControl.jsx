import { useEffect, useRef, useState } from "react";
import { deleteAccount, exportAccountData, getApiErrorMessage } from "../api/client.js";
import { useAuth } from "../auth/AuthContext.jsx";
import "./AccountControl.css";

function AccountControl() {
  const auth = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const displayName = getDisplayName(auth.user);

  if (!auth.authReady) {
    return <div className="account-control account-control--loading" aria-label="Checking sign-in status" />;
  }

  if (!auth.user) {
    return (
      <div className="account-control">
        <button type="button" className="account-sign-in" onClick={() => setDialogOpen(true)}>
          Sign in
        </button>
        {dialogOpen ? <SignInDialog auth={auth} onClose={() => setDialogOpen(false)} /> : null}
      </div>
    );
  }

  return (
    <div className="account-control">
      <button
        type="button"
        className="account-avatar-button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((value) => !value)}
      >
        <Avatar user={auth.user} />
        <span>{displayName}</span>
      </button>
      {menuOpen ? <AccountMenu auth={auth} onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

function SignInDialog({ auth, onClose }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    function escape(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  async function signInWithGoogle() {
    setBusy(true);
    setStatus("");
    const { error } = await auth.supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) { setStatus(error.message); setBusy(false); }
  }

  async function emailMagicLink(event) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    const { error } = await auth.supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setStatus(error ? error.message : "Check your email for your secure Dishly sign-in link.");
    setBusy(false);
  }

  return (
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <button ref={closeRef} type="button" className="account-dialog-close" onClick={onClose} aria-label="Close sign-in">×</button>
        <p className="account-dialog-eyebrow">Optional account</p>
        <h2 id="account-dialog-title">Save recipes everywhere</h2>
        <p>Dishly stays fully usable as a guest. Sign in only if you want your liked recipes, notes, ratings, and collections synced.</p>
        {!auth.accountAvailable ? (
          <div className="account-unavailable" role="status">Cloud accounts are being connected. Guest mode is still ready to use.</div>
        ) : (
          <>
            <button type="button" className="account-google-button" onClick={signInWithGoogle} disabled={busy}>
              Continue with Google
            </button>
            <div className="account-divider"><span>or use a magic link</span></div>
            <form onSubmit={emailMagicLink}>
              <label htmlFor="dishly-sign-in-email">Email address</label>
              <div className="account-email-row">
                <input id="dishly-sign-in-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                <button type="submit" disabled={busy}>Email link</button>
              </div>
            </form>
            {status ? <p className="account-status" role="status">{status}</p> : null}
          </>
        )}
        <small>No password to remember. The account layer uses Supabase's free plan.</small>
      </section>
    </div>
  );
}

function AccountMenu({ auth, onClose }) {
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function downloadData() {
    setError("");
    try {
      const blob = await exportAccountData(auth.accessToken);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dishly-data.json";
      link.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (requestError) { setError(getApiErrorMessage(requestError, "Couldn't export your data.")); }
  }

  async function removeAccount() {
    if (window.prompt("This permanently deletes your Dishly account and saved data. Type DELETE to continue.") !== "DELETE") return;
    setDeleting(true);
    setError("");
    try {
      await deleteAccount(auth.accessToken);
      await auth.supabase.auth.signOut({ scope: "local" });
      onClose();
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Couldn't delete your account."));
      setDeleting(false);
    }
  }

  return (
    <div className="account-menu" role="menu">
      <div className="account-menu-identity"><strong>{getDisplayName(auth.user)}</strong><span>{auth.user.email}</span></div>
      {auth.migrationStatus === "importing" ? <p role="status">Importing guest recipes…</p> : null}
      {auth.migrationStatus === "failed" ? <p role="alert">Guest recipe import will retry.</p> : null}
      <a href="/liked" role="menuitem">My saved recipes</a>
      <button type="button" role="menuitem" onClick={downloadData}>Download my data</button>
      <button type="button" role="menuitem" onClick={() => auth.supabase.auth.signOut()}>Sign out</button>
      <button type="button" role="menuitem" className="account-delete" onClick={removeAccount} disabled={deleting}>Delete account</button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function Avatar({ user }) {
  const image = user.user_metadata?.avatar_url;
  if (typeof image === "string" && /^https?:\/\//.test(image)) return <img src={image} alt="" referrerPolicy="no-referrer" />;
  return <span aria-hidden="true">{getDisplayName(user).slice(0, 1).toUpperCase()}</span>;
}

function getDisplayName(user) {
  return user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "Account";
}

export default AccountControl;
