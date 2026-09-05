import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import { AppRouter } from "./AppRouter.tsx";
import { hydrateAvatarStore } from "./components/avatar/useAvatarStore";

// Seed the avatar store from the checked-in `public/char/avatar.manifest.json`
// (via GET) before first paint, so the DevPage nav-rig and tuning sidebar both
// start on the file's saved character rather than the built-in defaults.
void hydrateAvatarStore().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>,
  );
});
