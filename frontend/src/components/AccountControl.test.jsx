import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, guestValue } from "../auth/AuthContext.jsx";
import AccountControl from "./AccountControl.jsx";

const apiMocks = vi.hoisted(() => ({ deleteAccount: vi.fn(), exportAccountData: vi.fn() }));
vi.mock("../api/client.js", () => ({
  deleteAccount: apiMocks.deleteAccount,
  exportAccountData: apiMocks.exportAccountData,
  getApiErrorMessage: (error, fallback) => error?.response?.data?.error || fallback,
}));

function renderControl(value) {
  return render(<AuthContext.Provider value={{ ...guestValue, ...value }}><AccountControl /></AuthContext.Provider>);
}

describe("AccountControl", () => {
  beforeEach(() => {
    apiMocks.deleteAccount.mockReset().mockResolvedValue(undefined);
    apiMocks.exportAccountData.mockReset().mockResolvedValue(new Blob(["{}"]));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it("reserves a quiet slot while auth initializes", () => {
    renderControl({ authReady: false });
    expect(screen.getByLabelText("Checking sign-in status")).toBeInTheDocument();
  });

  it("opens optional sign-in without blocking guest mode and closes accessibly", async () => {
    const user = userEvent.setup();
    renderControl({ authReady: true, accountAvailable: false });
    const signIn = screen.getByRole("button", { name: "Sign in to save" });
    await user.click(signIn);
    expect(screen.getByRole("dialog", { name: "Sign in to Dishly" })).toBeVisible();
    expect(screen.getByText(/save your recipes on every device/i)).toBeVisible();
    expect(screen.getByText(/isn’t available yet/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
    expect(screen.getByLabelText("Email address")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send sign-in link" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(signIn).toHaveFocus();
  });

  it("lets guests dismiss sign-in with an explicit guest action", async () => {
    const user = userEvent.setup();
    renderControl({ authReady: true, accountAvailable: false });
    await user.click(screen.getByRole("button", { name: "Sign in to save" }));
    await user.click(screen.getByRole("button", { name: "Continue as guest" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps keyboard focus inside the open sign-in dialog", async () => {
    const user = userEvent.setup();
    renderControl({ authReady: true, accountAvailable: false });
    await user.click(screen.getByRole("button", { name: "Sign in to save" }));
    const close = screen.getByRole("button", { name: "Close sign-in" });
    const guest = screen.getByRole("button", { name: "Continue as guest" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(guest).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("starts Google OAuth and sends passwordless email magic links", async () => {
    const user = userEvent.setup();
    const signInWithOAuth = vi.fn().mockResolvedValue({ error: null });
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    const first = renderControl({ authReady: true, accountAvailable: true, supabase: { auth: { signInWithOAuth, signInWithOtp } } });
    await user.click(screen.getByRole("button", { name: "Sign in to save" }));
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: window.location.origin } });

    first.unmount();
    renderControl({ authReady: true, accountAvailable: true, supabase: { auth: { signInWithOAuth, signInWithOtp } } });
    await user.click(screen.getByRole("button", { name: "Sign in to save" }));

    await user.type(screen.getByLabelText("Email address"), "cook@example.com");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));
    expect(signInWithOtp).toHaveBeenCalledWith({ email: "cook@example.com", options: { emailRedirectTo: window.location.origin } });
    expect(screen.getByText(/check your email/i)).toBeVisible();
  });

  it("shows provider errors inside the sign-in dialog", async () => {
    const user = userEvent.setup();
    const signInWithOAuth = vi.fn().mockResolvedValue({ error: new Error("Google unavailable") });
    const signInWithOtp = vi.fn().mockResolvedValue({ error: new Error("Email unavailable") });
    renderControl({ authReady: true, accountAvailable: true, supabase: { auth: { signInWithOAuth, signInWithOtp } } });
    await user.click(screen.getByRole("button", { name: "Sign in to save" }));
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(screen.getByText("Google unavailable")).toBeVisible();
    await user.type(screen.getByLabelText("Email address"), "cook@example.com");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));
    expect(screen.getByText("Email unavailable")).toBeVisible();
  });

  it("provides saved recipes, export, sign-out, migration status, and exact account deletion", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("DELETE");
    renderControl({
      authReady: true,
      accountAvailable: true,
      accessToken: "token",
      user: { email: "cook@example.com", user_metadata: { full_name: "Dishly Cook", avatar_url: "https://example.com/avatar.jpg" } },
      supabase: { auth: { signOut } },
      migrationStatus: "importing",
    });
    await user.click(screen.getByRole("button", { name: /Dishly Cook/ }));
    expect(screen.getByRole("menuitem", { name: "My saved recipes" })).toHaveAttribute("href", "/liked");
    expect(screen.getByText(/importing guest recipes/i)).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Download my data" }));
    expect(apiMocks.exportAccountData).toHaveBeenCalledWith("token");

    await user.click(screen.getByRole("button", { name: /Dishly Cook/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Delete account" }));
    await waitFor(() => expect(apiMocks.deleteAccount).toHaveBeenCalledWith("token"));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    prompt.mockRestore();
  });

  it("keeps account-menu failures visible and allows deletion cancellation", async () => {
    const user = userEvent.setup();
    apiMocks.exportAccountData.mockRejectedValue({ response: { data: { error: "Export failed" } } });
    vi.spyOn(window, "prompt").mockReturnValue("cancel");
    renderControl({ authReady: true, accountAvailable: true, accessToken: "token", user: { email: "cook@example.com", user_metadata: {} }, supabase: { auth: { signOut: vi.fn() } }, migrationStatus: "failed" });
    await user.click(screen.getByRole("button", { name: /cook/ }));
    await user.click(screen.getByRole("menuitem", { name: "Download my data" }));
    expect(await screen.findByText("Export failed")).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Delete account" }));
    expect(apiMocks.deleteAccount).not.toHaveBeenCalled();
  });
});
