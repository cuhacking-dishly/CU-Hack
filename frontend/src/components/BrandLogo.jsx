import { Link } from "react-router-dom";
import "./BrandLogo.css";

/**
 * The persistent, accessible home link for Dishly's primary product surfaces.
 * The shared mark is a tightly framed alpha-transparent raster asset. Every
 * product surface uses this same uncropped logo for a consistent brand system.
 */
function BrandLogo({ className = "", src = "/images/dishly-logo-hero.png" }) {
  return (
    <Link className={["brand-logo", className].filter(Boolean).join(" ")} to="/" aria-label="Dishly home">
      <span className="brand-logo__crop">
        <img src={src} alt="" width="1232" height="479" />
      </span>
    </Link>
  );
}

export default BrandLogo;
