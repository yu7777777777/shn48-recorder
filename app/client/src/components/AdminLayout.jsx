import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  IconArchive,
  IconLayers,
  IconBilibili,
  IconHome,
  IconLive,
  IconLogOut,
  IconMenu,
  IconRefresh,
  IconSettings,
  IconShield,
  IconTv,
  IconUsers,
  IconX,
} from "./Icons";
import { adminApi } from "../lib/api";
import "../styles/AdminShell.css";
import "../styles/AdminPages.css";

const navItems = [
  { path: "/admin/overview", label: "总览", icon: IconHome },
  { path: "/admin/live", label: "直播管理", icon: IconLive },
  { path: "/admin/auto-record", label: "自动录制", icon: IconRefresh },
  { path: "/admin/pocket48", label: "口袋48", icon: IconTv },
  { path: "/admin/archive", label: "录像归档", icon: IconArchive },
  { path: "/admin/search", label: "字幕搜索", icon: IconLayers },
  { path: "/admin/replay-analysis", label: "回放分析", icon: IconLayers },
  { path: "/admin/replay-audit", label: "历史审计", icon: IconLayers },

  { path: "/admin/social", label: "成员社交账号", icon: IconUsers },
  { path: "/admin/analysis-settings", label: "字幕与 AI", icon: IconSettings },
  { path: "/admin/notify", label: "通知推送", icon: IconSettings },
  { path: "/admin/bilibili", label: "B站草稿", icon: IconBilibili },
  { path: "/admin/settings", label: "系统设置", icon: IconSettings },
  { path: "/admin/security", label: "账户安全", icon: IconShield },
];

const NAV_SECTIONS = [
  { label: "工作台", from: 0, to: 5 },
  { label: "内容工具", from: 5, to: 9 },
  { label: "系统", from: 9, to: navItems.length },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function logout() {
    try {
      await adminApi.post("/auth/logout");
    } catch {}
    navigate("/admin/login", { replace: true });
  }

  return (
    <div className="admin-app">
      {mobileOpen && (
        <div
          className="mobile-sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <IconTv size={16} />
          </div>
          <div className="brand-text">
            <span>48tools</span>
            <em>管理台</em>
          </div>
          {mobileOpen && (
            <button
              type="button"
              className="text-button"
              onClick={() => setMobileOpen(false)}
              aria-label="关闭侧边栏"
            >
              <IconX size={18} />
            </button>
          )}
        </div>

        <nav className="sidebar-nav" aria-label="管理导航">
          {NAV_SECTIONS.map((section, index) => (
            <React.Fragment key={section.label}>
              <div
                className={`sidebar-section-label ${
                  index === 0 ? "" : "sidebar-section-label-secondary"
                }`}
              >
                {section.label}
              </div>
              {navItems.slice(section.from, section.to).map((item) => {
                const IconComponent = item.icon;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    className={({ isActive }) =>
                      `nav-item ${isActive ? "active" : ""}`
                    }
                    onClick={() => setMobileOpen(false)}
                  >
                    <IconComponent size={17} />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </React.Fragment>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-logout" onClick={logout}>
            <IconLogOut size={14} />
            <span>退出</span>
          </button>
          <span className="version-badge">
            <span className="version-dot" />v{__APP_VERSION__}
          </span>
        </div>
      </aside>

      <div className="mobile-header-bar">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setMobileOpen(true)}
          aria-label="展开导航"
        >
          <IconMenu size={15} />
          <span>导航</span>
        </button>
        <div className="brand-text">
          <span>48tools</span>
        </div>
      </div>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
