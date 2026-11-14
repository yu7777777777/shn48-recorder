import React, { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AdminLayout from "./components/AdminLayout";
import AuthGuard from "./components/AuthGuard";
import LoadingState from "./components/LoadingState";
import { ToastProvider } from "./components/Toast";
import "./App.css";

// Pages are split per route: the public live page never pays for the admin
// console bundles, and admin tabs load on demand.
const AdminLoginPage = lazy(() => import("./pages/AdminLogin"));
const AutoRecordPage = lazy(() => import("./pages/AutoRecord"));
const Pocket48Page = lazy(() => import("./pages/Pocket48"));
const BilibiliPage = lazy(() => import("./pages/Bilibili"));
const ConfigPage = lazy(() => import("./pages/Config"));
const DashboardPage = lazy(() => import("./pages/Dashboard"));
const AdminLivePage = lazy(() => import("./pages/Live"));
const PublicLivePage = lazy(() => import("./pages/PublicLive"));
const PublicReplayPage = lazy(() => import("./pages/PublicReplay"));
const PublicSocialPage = lazy(() => import("./pages/PublicSocial"));
const SecurityPage = lazy(() => import("./pages/Security"));
const ArchivePage = lazy(() => import("./pages/Video"));
const ReplayAudit = lazy(() => import("./pages/ReplayAudit"));
const UpdateChecker = lazy(() => import("./pages/UpdateChecker"));
const SocialAccountsPage = lazy(() => import("./pages/SocialAccounts"));


export default function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/" element={<PublicLivePage />} />
          <Route path="/live/:liveId" element={<PublicLivePage />} />
          <Route path="/replays" element={<PublicReplayPage />} />
          <Route path="/replays/:replayId" element={<PublicReplayPage />} />
            <Route path="/s/:code" element={<PublicSocialPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route element={<AuthGuard />}>
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<DashboardPage />} />
              <Route path="live" element={<AdminLivePage />} />
              <Route path="archive" element={<ArchivePage />} />
              <Route path="replay-audit" element={<ReplayAudit />} />
              <Route path="update" element={<UpdateChecker />} />
              <Route path="social" element={<SocialAccountsPage />} />
              {/* Retired tools: preserve old bookmarks without loading obsolete pages. */}
              <Route path="cover-settings" element={<Navigate to="/admin/archive" replace />} />
              <Route path="room-voice" element={<Navigate to="/admin/pocket48" replace />} />
              <Route path="search" element={<Navigate to="/admin/archive" replace />} />
              <Route path="replay-analysis" element={<Navigate to="/admin/archive" replace />} />
              <Route path="analysis-settings" element={<Navigate to="/admin/settings" replace />} />
              <Route path="notify" element={<Navigate to="/admin/settings" replace />} />
              <Route path="archive/:id" element={<Navigate to="/admin/archive" replace />} />
              <Route path="bilibili" element={<BilibiliPage />} />
              <Route path="settings" element={<ConfigPage />} />
              <Route path="security" element={<SecurityPage />} />
              <Route path="auto-record" element={<AutoRecordPage />} />
              <Route path="pocket48" element={<Pocket48Page />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
