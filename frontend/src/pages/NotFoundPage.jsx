import { Link } from "react-router-dom";
import "./NotFoundPage.css";

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <section className="not-found-panel" aria-labelledby="not-found-title">
        <p className="not-found-eyebrow">Dishly</p>
        <h1 id="not-found-title">This page is not on the menu</h1>
        <p>The link may be outdated. Start with a food goal to build a fresh recipe deck.</p>
        <Link to="/">Go to goal entry</Link>
      </section>
    </main>
  );
}

export default NotFoundPage;
