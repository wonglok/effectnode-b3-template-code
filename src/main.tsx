import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./index.css";
import { AppRouter } from "./AppRouter.tsx";

createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <AppRouter />
  </HashRouter>,
);
