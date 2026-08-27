import { Link } from "react-router-dom";
import { CubeIcon } from "./Icons";

type PageKey = "home" | "dev" | "production" | "deployment";

interface SiteMenuProps {
  active?: PageKey;
}

const navItems: { key: PageKey; label: string; to: string }[] = [
  { key: "home", label: "Home", to: "/" },
  { key: "dev", label: "Dev", to: "/dev" },
  { key: "production", label: "Production", to: "/production" },
  { key: "deployment", label: "Deployment", to: "/deployment" },
];

export function SiteMenu({ active }: SiteMenuProps) {
  return (
    <header className="shrink-0 h-11 bg-studio-850 border-b border-studio-700 flex items-center justify-between px-4">
      {/* Brand */}
      <div className="flex items-center gap-3 min-w-0">
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-tiffany-300 to-tiffany-600 flex items-center justify-center">
            <CubeIcon className="w-3.5 h-3.5 text-studio-900" />
          </div>
          <span className="text-sm font-semibold tracking-tight">
            effect
            <span className="text-tiffany-400">node</span>
          </span>
        </Link>
        <div className="w-px h-4 bg-studio-700" />
        <span className="hidden sm:block text-xs text-ice-600 font-mono">
          b3 template
        </span>
      </div>

      {/* Menu */}
      <nav className="flex items-center gap-1">
        {navItems.map((item) => {
          const isActive = active === item.key;
          return (
            <Link
              key={item.key}
              to={item.to}
              aria-current={isActive ? "page" : undefined}
              className={`relative px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                isActive
                  ? "bg-tiffany-400/10 text-tiffany-300"
                  : "text-ice-400 hover:bg-studio-800 hover:text-ice-50"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
