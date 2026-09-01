import { useEffect, useRef, useState } from "react";
import { deleteAccount, exportAccountData, getApiErrorMessage } from "../api/client.js";
import { useAuth } from "../auth/AuthContext.jsx";
import "./AccountControl.css";

function AccountControl() {
  const auth = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const signInRef = useRef(null);
  const dialogWasOpen = useRef(false);
  const displayName = getDisplayName(auth.user);

  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) signInRef.current?.focus();
    dialogWasOpen.current = dialogOpen;
  }, [dialogOpen]);

  if (!auth.authReady) {
    return <div className="account-control account-control--loading" aria-label="Checking sign-in status" />;
  }

  if (!auth.user) {
    return (
      <div className="account-control">
        <button ref={signInRef} type="button" className="account-sign-in" onClick={() => setDialogOpen(true)}>
          Sign in to save
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
  const [statusIsError, setStatusIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const accountAvailable = Boolean(auth.accountAvailable && auth.supabase?.auth);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll("button:not([disabled]), input:not([disabled])") || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function signInWithGoogle() {
    if (!accountAvailable) return;
    setBusy(true);
    setStatus("");
    setStatusIsError(false);
    const { error } = await auth.supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setStatus(error.message);
      setStatusIsError(true);
      setBusy(false);
    }
  }

  async function emailMagicLink(event) {
    event.preventDefault();
    if (!accountAvailable) return;
    setBusy(true);
    setStatus("");
    setStatusIsError(false);
    const { error } = await auth.supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setStatus(error ? error.message : "Check your email for your secure Dishly sign-in link.");
    setStatusIsError(Boolean(error));
    setBusy(false);
  }

  return (
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" aria-describedby="account-dialog-description">
        <button ref={closeRef} type="button" className="account-dialog-close" onClick={onClose} aria-label="Close sign-in">×</button>
        <h2 id="account-dialog-title">Sign in to Dishly</h2>
        <p id="account-dialog-description" className="account-dialog-subtitle">Save your recipes on every device.</p>

        {!accountAvailable ? (
          <p className="account-unavailable" role="status">Sign-in isn’t available yet. Guest mode still works normally.</p>
        ) : null}

        <button type="button" className="account-google-button" onClick={signInWithGoogle} disabled={busy || !accountAvailable}>
          <GoogleMark />
          <span>Continue with Google</span>
        </button>

        <div className="account-divider"><span>or</span></div>

        <form onSubmit={emailMagicLink}>
          <label htmlFor="dishly-sign-in-email">Email address</label>
          <input
            id="dishly-sign-in-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            disabled={busy || !accountAvailable}
          />
          <button type="submit" className="account-email-button" disabled={busy || !accountAvailable}>Send sign-in link</button>
        </form>

        {status ? <p className={`account-status${statusIsError ? " account-status--error" : ""}`} role={statusIsError ? "alert" : "status"}>{status}</p> : null}

        <button type="button" className="account-guest-button" onClick={onClose}>Continue as guest</button>
        <small>No password required.</small>
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="account-google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.74-.07-1.46-.19-2.15H12v4.07h5.38a4.6 4.6 0 0 1-2 3.02v2.64h3.24c1.9-1.75 2.98-4.33 2.98-7.58Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.64c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.73A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.76A6.02 6.02 0 0 1 6.07 12c0-.61.11-1.2.32-1.76V7.51H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.49l3.35-2.73Z" />
      <path fill="#EA4335" d="M12 6.11c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.73C7.18 7.87 9.39 6.11 12 6.11Z" />
    </svg>
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
