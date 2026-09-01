import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext.jsx";

const mocks = vi.hoisted(() => ({
  clearLikedRecipes: vi.fn(),
  createClient: vi.fn(),
  getAuthConfig: vi.fn(),
  getLikedRecipes: vi.fn(),
  importCloudRecipes: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("../api/client.js", () => ({ getAuthConfig: mocks.getAuthConfig, importCloudRecipes: mocks.importCloudRecipes }));
vi.mock("../utils/likedRecipes.js", () => ({ clearLikedRecipes: mocks.clearLikedRecipes, getLikedRecipes: mocks.getLikedRecipes }));

function Inspector() {
  const auth = useAuth();
  return <div><span data-testid="ready">{String(auth.authReady)}</span><span data-testid="available">{String(auth.accountAvailable)}</span><span data-testid="user">{auth.user?.id || "guest"}</span><span data-testid="migration">{auth.migrationStatus}</span><button onClick={() => auth.refreshSession()}>Refresh</button></div>;
}

function session(id = "user-1") { return { access_token: "access-token", user: { id, email: "cook@example.com" } }; }

describe("AuthProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.clearLikedRecipes.mockReset();
    mocks.createClient.mockReset();
    mocks.getAuthConfig.mockReset();
    mocks.getLikedRecipes.mockReset().mockReturnValue([{ id: "101", title: "Recipe" }]);
    mocks.importCloudRecipes.mockReset().mockResolvedValue({ imported: 1 });
  });

  it("keeps guest mode ready when optional accounts are disabled or configuration fails", async () => {
    mocks.getAuthConfig.mockResolvedValue({ enabled: false });
    const { unmount } = render(<AuthProvider><Inspector /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("available")).toHaveTextContent("false");
    expect(screen.getByTestId("user")).toHaveTextContent("guest");
    unmount();

    mocks.getAuthConfig.mockRejectedValue(new Error("offline"));
    render(<AuthProvider><Inspector /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("restores a session, imports guest likes exactly once, refreshes, and follows auth changes", async () => {
    const unsubscribe = vi.fn();
    const refreshSession = vi.fn().mockResolvedValue({ data: { session: session() } });
    let listener;
    const client = { auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: session() } }),
      onAuthStateChange: vi.fn((callback) => { listener = callback; return { data: { subscription: { unsubscribe } } }; }),
      refreshSession,
    }};
    mocks.getAuthConfig.mockResolvedValue({ enabled: true, url: "https://project.supabase.co", publishableKey: "public" });
    mocks.createClient.mockReturnValue(client);
    const user = userEvent.setup();
    const { unmount } = render(<AuthProvider><Inspector /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("user-1"));
    await waitFor(() => expect(mocks.importCloudRecipes).toHaveBeenCalledWith("access-token", [{ id: "101", title: "Recipe" }]));
    await waitFor(() => expect(screen.getByTestId("migration")).toHaveTextContent("complete"));
    expect(mocks.clearLikedRecipes).toHaveBeenCalledWith("demo-user-1");
    expect(window.localStorage.getItem("dishly:guest-imported:v1:user-1")).toBe("yes");
    expect(mocks.createClient).toHaveBeenCalledWith("https://project.supabase.co", "public", expect.objectContaining({ auth: expect.objectContaining({ persistSession: true }) }));

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshSession).toHaveBeenCalled();
    listener("SIGNED_OUT", null);
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("guest"));
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("retains guest data and exposes a retryable failure when cloud import fails", async () => {
    const client = { auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: session("user-2") } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      refreshSession: vi.fn(),
    }};
    mocks.getAuthConfig.mockResolvedValue({ enabled: true, url: "https://project.supabase.co", publishableKey: "public" });
    mocks.createClient.mockReturnValue(client);
    mocks.importCloudRecipes.mockRejectedValue(new Error("offline"));
    render(<AuthProvider><Inspector /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("migration")).toHaveTextContent("failed"));
    expect(mocks.clearLikedRecipes).not.toHaveBeenCalled();
  });
});
