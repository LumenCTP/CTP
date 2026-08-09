import { useState } from "react";
import { Outlet } from "react-router-dom";
import PartnerSidebar from "./PartnerSidebar";
import TopBar from "./TopBar";

// Partner portal shell — same layout as the construction-company app shell but
// with the partner-specific sidebar (no Clients/Vendors/Documents/Reports).
export default function PartnerShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  return (
    <div className="app-layout">
      <PartnerSidebar
        collapsed={sidebarCollapsed}
        onClose={() => setSidebarCollapsed(true)}
      />
      <div className="main-area">
        <TopBar onMenuToggle={() => setSidebarCollapsed((v) => !v)} />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
