import { useState } from "react";
import { Outlet } from "react-router-dom";
import AdminSidebar from "./AdminSidebar";
import TopBar from "./TopBar";

// Admin shell — same layout as the construction-company app shell but with the
// admin sidebar (Dashboard/Partners/Referrals/Commissions/Payouts/Audit Log)
// and an "Admin" badge in the top bar. Only reachable via AdminRoute.
export default function AdminShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  return (
    <div className="app-layout">
      <AdminSidebar
        collapsed={sidebarCollapsed}
        onClose={() => setSidebarCollapsed(true)}
      />
      <div className="main-area">
        <TopBar onMenuToggle={() => setSidebarCollapsed((v) => !v)} badge="Admin" />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
