import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import HelpWidget from "./HelpWidget";

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  return (
    <div className="app-layout">
      <Sidebar
        collapsed={sidebarCollapsed}
        onClose={() => setSidebarCollapsed(true)}
      />
      <div className="main-area">
        <TopBar onMenuToggle={() => setSidebarCollapsed((v) => !v)} />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
      <HelpWidget />
    </div>
  );
}
