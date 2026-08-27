import { Routes, Route } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { DevPage } from "./pages/DevPage";
import { ProductionPage } from "./pages/ProductionPage";
import { DeployedPage } from "./pages/DeployedPage";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/dev" element={<DevPage />} />
      <Route path="/deployment" element={<DeployedPage />} />
      <Route path="/production" element={<ProductionPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}

//
//
//

//
//
//
