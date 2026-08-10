import Logo from "./Logo";
import { useAuth } from "./AuthContext";

interface TopBarProps {
  onMenuToggle: () => void;
  badge?: string;
}

export default function TopBar({ onMenuToggle, badge }: TopBarProps) {
  const { user, logout } = useAuth();

  const initial = user?.full_name?.charAt(0)?.toUpperCase() || "?";
  const displayName = user?.full_name || "User";

  return (
    <header className="topbar">
      <button className="menu-toggle" onClick={onMenuToggle} aria-label="Toggle menu">
        ☰
      </button>
      <div className="topbar-brand">
        <Logo size={32} />
      </div>
      {badge && <span className="topbar-badge">{badge}</span>}
      <div className="topbar-spacer" />
      <div className="topbar-user" title={displayName}>
        <span className="user-avatar">{initial}</span>
        <span className="user-name">{displayName}</span>
        <button className="logout-btn" onClick={logout} title="Sign out">
          ↵
        </button>
      </div>
    </header>
  );
}
