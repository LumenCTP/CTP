import { NavLink } from "react-router-dom";

const partnerNavItems = [
  { to: "/app/partner/dashboard", label: "Dashboard", icon: "⌂" },
  { to: "/app/partner/refer", label: "Refer a Client", icon: "➕" },
  { to: "/app/partner/referrals", label: "My Referrals", icon: "👥" },
  { to: "/app/partner/commissions", label: "Commissions", icon: "💰" },
  { to: "/app/partner/payouts", label: "Payouts", icon: "🏦" },
];

interface PartnerSidebarProps {
  collapsed: boolean;
  onClose: () => void;
}

export default function PartnerSidebar({ collapsed, onClose }: PartnerSidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div className="sidebar-overlay" onClick={onClose} />
      )}

      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">CTP</div>
        <nav className="sidebar-nav">
          {partnerNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/app/partner/dashboard"}
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
