import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/app", label: "Dashboard", icon: "⌂" },
  { to: "/app/clients", label: "Clients", icon: "▦" },
  { to: "/app/vendors", label: "Vendors", icon: "👥" },
  { to: "/app/documents", label: "Documents", icon: "📄" },
  { to: "/app/reports", label: "Reports", icon: "📊" },
  { to: "/app/needs-review", label: "Needs Review", icon: "⚠" },
  { to: "/app/email-log", label: "Email Log", icon: "✉" },
];

interface SidebarProps {
  collapsed: boolean;
  onClose: () => void;
}

export default function Sidebar({ collapsed, onClose }: SidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div className="sidebar-overlay" onClick={onClose} />
      )}

      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">CTP</div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? "active" : ""}`
              }
              onClick={() => {
                // Close sidebar on mobile after navigation
                if (window.innerWidth < 768) onClose();
              }}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}
