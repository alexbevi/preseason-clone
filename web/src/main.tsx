import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";

// Vite injects BASE_URL from `base:` in vite.config.ts. On GitHub Pages we
// serve from /preseason-clone/, but for local `vite dev` it's /. Strip the
// trailing slash so react-router's basename doesn't double up.
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

// GitHub Pages SPA shim: 404.html redirects deep links into /?p=/path&q=...
// so we can rewrite history back to the original URL before the router boots.
const params = new URLSearchParams(window.location.search);
const redirectPath = params.get("p");
if (redirectPath) {
  params.delete("p");
  const inner = params.get("q") ?? "";
  params.delete("q");
  const rest = params.toString();
  const url =
    (basename === "/" ? "" : basename) +
    redirectPath +
    (inner ? `?${inner}` : "") +
    (rest ? (inner ? `&${rest}` : `?${rest}`) : "") +
    window.location.hash;
  window.history.replaceState(null, "", url);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
