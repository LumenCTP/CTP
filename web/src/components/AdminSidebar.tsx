import { NavLink } from "react-router-dom";
import Logo from "./Logo";

// Admin-only navigation — this sidebar is only ever rendered inside AdminShell,
// which is guarded by AdminRoute (role === "admin").
const adminNavItems = [
  { to: "/app/admin/dashboard", label: "Dashboard", icon: "⌂" },
  { to: "/app/admin/partners", label: "Partners", icon: "🤝" },
  { to: "/app/admin/referrals", label: "Referrals", icon: "👥" },
  { to: "/app/admin/commissions", label: "Commissions", icon: "💰" },
  { to: "/app/admin/payouts", label: "Payouts", icon: "🏦" },
  { to: "/app/admin/audit", label: "Audit Log", icon: "🕮" },
  { to: "/app/admin/accounts", label: "Clients", icon: "🏢" },
  { to: "/app/admin/questions", label: "Questions", icon: "❓" },
  { to: "/app/admin/cashflow", label: "Cash Flow", icon: "📈" },
];

interface AdminSidebarProps {
  collapsed: boolean;
  onClose: () => void;
}

export default function AdminSidebar({ collapsed, onClose }: AdminSidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div className="sidebar-overlay" onClick={onClose} />
      )}

      <aside className={`sidebar admin-sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">
          <Logo size={32} showText={false} /><span className="sidebar-brand-tag">Admin</span>
        </div>
        <nav className="sidebar-nav">
          {adminNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/app/admin/dashboard"}
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
