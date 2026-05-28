import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { loadDataset } from "./data";
import type { Dataset } from "./data";
import { Matchups } from "./pages/Matchups";
import { ToolDetail } from "./pages/ToolDetail";
import { PromptsList } from "./pages/PromptsList";
import { PromptDetail } from "./pages/PromptDetail";

export default function App() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDataset().then(setData).catch((e) => setError(String(e)));
  }, []);

  if (error)
    return (
      <div className="app">
        <div className="notice">Error: {error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="app">
        <div className="empty-state">Loading…</div>
      </div>
    );

  return (
    <div className="app">
      <nav className="nav">
        <Link to="/" className="brand">
          <h1>preseason.ai mirror</h1>
        </Link>
        <div className="nav-links">
          <NavLink to="/" end>
            Matchups
          </NavLink>
          <NavLink to="/prompts">Prompts</NavLink>
        </div>
      </nav>

      <Routes>
        <Route path="/" element={<Matchups data={data} />} />
        <Route path="/tool/:slug" element={<ToolDetail data={data} />} />
        <Route path="/prompts" element={<PromptsList data={data} />} />
        <Route path="/prompt/:slug" element={<PromptDetail data={data} />} />
      </Routes>
    </div>
  );
}
