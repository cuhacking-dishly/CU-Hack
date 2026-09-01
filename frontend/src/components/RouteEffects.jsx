import { useEffect } from "react";
import { useLocation } from "react-router-dom";

function getRouteTitle() {
  return "dishly";
}

function RouteEffects() {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = getRouteTitle();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    let observer;

    function focusCurrentRouteHeading() {
      const routeContainers = [...document.querySelectorAll(".route-transition")];
      const routeContainer = routeContainers.find(
        (element) => element.getAttribute("data-route") === pathname,
      );
      const heading = routeContainer?.querySelector("main h1") ||
        (routeContainers.length === 0 ? document.querySelector("main h1") : null);

      if (!(heading instanceof HTMLElement)) return false;

      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return true;
    }

    const frame = window.requestAnimationFrame(() => {
      if (focusCurrentRouteHeading()) return;

      observer = new MutationObserver(() => {
        if (focusCurrentRouteHeading()) observer.disconnect();
      });
      observer.observe(document.getElementById("root") || document.body, {
        childList: true,
        subtree: true,
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [pathname]);

  return null;
}

export default RouteEffects;
