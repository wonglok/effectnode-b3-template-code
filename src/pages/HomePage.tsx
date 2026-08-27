import { Link } from "react-router-dom";
import { SiteMenu } from "../components/SiteMenu";
import { CubeIcon, RadioIcon, MonitorIcon } from "../components/Icons";

export function HomePage() {
  return (
    <div className="relative min-h-screen bg-studio-900 text-ice-50 flex flex-col overflow-hidden">
      <SiteMenu active="home" />

      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {/* Faint studio grid + light source */}
        <div className="viewport-grid animate-grid-drift absolute inset-0 opacity-40" />
        <div className="viewport-glow absolute inset-0" />

        <div className="relative max-w-2xl mx-auto px-6 py-20 text-center space-y-10">
          {/* Mark */}
          <div className="w-14 h-14 mx-auto rounded-lg bg-gradient-to-br from-tiffany-300 to-tiffany-600 flex items-center justify-center shadow-[0_0_40px_rgba(129,216,208,0.35)]">
            <CubeIcon className="w-6 h-6 text-studio-900" />
          </div>

          {/* Wordmark */}
          <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight">
            effect
            <span className="text-tiffany-400">node</span>
          </h1>

          {/* Pitch */}
          <div className="space-y-2">
            <p className="text-lg text-ice-200">
              From Blender to the web, live.
            </p>
            <p className="text-sm text-ice-600 max-w-md mx-auto">
              Receive a live Blender scene, snapshot it to OPFS, then preview
              the optimised deployment — all in the browser.
            </p>
          </div>

          {/* Menu / actions */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/dev"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-tiffany-400 hover:bg-tiffany-300 text-studio-900 text-sm font-semibold transition-colors"
            >
              <RadioIcon className="w-4 h-4" />
              Dev · Blender Receiver
            </Link>
            <Link
              to="/production"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-studio-700 bg-studio-800 hover:bg-studio-700 text-ice-200 text-sm font-medium transition-colors"
            >
              <MonitorIcon className="w-4 h-4" />
              Production Preview
            </Link>
            <Link
              to="/deployment"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-studio-700 bg-studio-800 hover:bg-studio-700 text-ice-200 text-sm font-medium transition-colors"
            >
              <MonitorIcon className="w-4 h-4" />
              Deployed Zip File
            </Link>
          </div>

          {/* Footer */}
          <div className="pt-4 flex flex-col items-center gap-3">
            <div className="h-px w-16 bg-studio-700" />
            <div className="flex items-center gap-4 text-xs text-ice-600 font-mono">
              <span>effectnode · b3sync</span>
              <Link
                to="/dev"
                className="hover:text-tiffany-400 transition-colors"
              >
                dev
              </Link>
              <Link
                to="/production"
                className="hover:text-tiffany-400 transition-colors"
              >
                production
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
