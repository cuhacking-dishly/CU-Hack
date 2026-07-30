/* oxlint-disable react/only-export-components -- Router components and hooks form one API. */

import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const RouterContext = createContext(null);
const ParamsContext = createContext({});

function decodePathValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePathname(pathname) {
  const value = typeof pathname === "string" && pathname.startsWith("/") ? pathname : "/";
  return value.length > 1 ? value.replace(/\/+$/, "") || "/" : value;
}

function normalizeLocation(entry, fallbackState = null) {
  const raw = typeof entry === "string" ? { pathname: entry } : entry || {};
  const base = new URL(
    typeof raw.pathname === "string" ? raw.pathname : "/",
    "https://dishly.local",
  );

  return Object.freeze({
    pathname: normalizePathname(base.pathname),
    search: typeof raw.search === "string" ? raw.search : base.search,
    hash: typeof raw.hash === "string" ? raw.hash : base.hash,
    state: Object.hasOwn(raw, "state") ? raw.state : fallbackState,
  });
}

function readBrowserLocation() {
  return normalizeLocation(
    {
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      state: window.history.state,
    },
    null,
  );
}

function destinationToPath(destination) {
  const raw =
    typeof destination === "string"
      ? destination
      : `${destination?.pathname || "/"}${destination?.search || ""}${destination?.hash || ""}`;

  if (!raw || raw.startsWith("//") || raw.includes("\\")) return "/";

  try {
    const baseOrigin =
      typeof window === "undefined" ? "https://dishly.local" : window.location.origin;
    const url = new URL(raw, baseOrigin);
    if (url.origin !== baseOrigin || !["http:", "https:"].includes(url.protocol)) return "/";
    return `${normalizePathname(url.pathname)}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function BrowserRouter({ children }) {
  const [location, setLocation] = useState(readBrowserLocation);

  useEffect(() => {
    const handlePopState = () => setLocation(readBrowserLocation());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((destination, options = {}) => {
    if (typeof destination === "number") {
      window.history.go(destination);
      return;
    }

    const path = destinationToPath(destination);
    const state = Object.hasOwn(options, "state") ? options.state : null;
    if (options.replace) {
      window.history.replaceState(state, "", path);
    } else {
      window.history.pushState(state, "", path);
    }
    setLocation(readBrowserLocation());
  }, []);

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function MemoryRouter({ children, initialEntries = ["/"], initialIndex }) {
  const startingEntries = useMemo(() => {
    const candidates = Array.isArray(initialEntries) && initialEntries.length ? initialEntries : ["/"];
    return candidates.map((entry) => normalizeLocation(entry));
  }, [initialEntries]);
  const requestedIndex = Number.isInteger(initialIndex) ? initialIndex : startingEntries.length - 1;
  const startingIndex = Math.min(Math.max(requestedIndex, 0), startingEntries.length - 1);
  const [history, setHistory] = useState(() => ({
    entries: startingEntries,
    index: startingIndex,
  }));

  const navigate = useCallback((destination, options = {}) => {
    setHistory((current) => {
      if (typeof destination === "number") {
        return {
          ...current,
          index: Math.min(Math.max(current.index + destination, 0), current.entries.length - 1),
        };
      }

      const nextLocation = normalizeLocation({
        pathname: destinationToPath(destination),
        state: Object.hasOwn(options, "state") ? options.state : null,
      });
      if (options.replace) {
        const entries = [...current.entries];
        entries[current.index] = nextLocation;
        return { entries, index: current.index };
      }

      const entries = [...current.entries.slice(0, current.index + 1), nextLocation];
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const location = history.entries[history.index];
  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function matchRoute(routePath, pathname) {
  if (routePath === "*") return {};
  if (typeof routePath !== "string" || !routePath.startsWith("/")) return null;

  const routeSegments = normalizePathname(routePath).split("/").filter(Boolean);
  const locationSegments = normalizePathname(pathname).split("/").filter(Boolean);
  if (routeSegments.length !== locationSegments.length) return null;

  const params = {};
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index];
    const locationSegment = locationSegments[index];
    if (routeSegment.startsWith(":")) {
      const key = routeSegment.slice(1);
      if (!key) return null;
      params[key] = decodePathValue(locationSegment);
    } else if (routeSegment !== locationSegment) {
      return null;
    }
  }
  return params;
}

function Routes({ children, location: locationOverride }) {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Routes must be rendered inside a Dishly router");

  const location =
    typeof locationOverride === "string"
      ? normalizeLocation(locationOverride)
      : locationOverride || router.location;

  for (const child of Children.toArray(children)) {
    if (!isValidElement(child) || child.type !== Route) continue;
    const params = matchRoute(child.props.path, location.pathname);
    if (params !== null) {
      return (
        <ParamsContext.Provider value={params}>
          {child.props.element ?? null}
        </ParamsContext.Provider>
      );
    }
  }
  return null;
}

function Route() {
  return null;
}

function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Router hooks must be used inside a Dishly router");
  return router;
}

function useLocation() {
  return useRouter().location;
}

function useNavigate() {
  return useRouter().navigate;
}

function useParams() {
  return useContext(ParamsContext);
}

function Link({
  children,
  download,
  onClick,
  replace = false,
  state,
  target,
  to,
  ...properties
}) {
  const navigate = useNavigate();
  const href = destinationToPath(to);

  function handleClick(event) {
    onClick?.(event);
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.altKey
      || event.ctrlKey
      || event.shiftKey
      || download
      || (target && target !== "_self")
    ) {
      return;
    }
    event.preventDefault();
    navigate(href, { replace, state });
  }

  return (
    <a
      {...properties}
      download={download}
      href={href}
      onClick={handleClick}
      target={target}
    >
      {children}
    </a>
  );
}

export {
  BrowserRouter,
  Link,
  MemoryRouter,
  Route,
  Routes,
  destinationToPath,
  matchRoute,
  useLocation,
  useNavigate,
  useParams,
};
