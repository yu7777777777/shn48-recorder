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
const PublicDailyPage = lazy(() => import("./pages/PublicDaily"));
const PublicSocialPage = lazy(() => import("./pages/PublicSocial"));
const SecurityPage = lazy(() => import("./pages/Security"));
const ArchivePage = lazy(() => import("./pages/Video"));
const RecordingDetail = lazy(() => import("./pages/RecordingDetail"));
const ReplayAudit = lazy(() => import("./pages/ReplayAudit"));
const AnalysisSettings = lazy(() => import("./pages/AnalysisSettings"));
const NotifySettings = lazy(() => import("./pages/NotifySettings"));
const SubtitleSearch = lazy(() => import("./pages/SubtitleSearch"));
const SocialAccountsPage = lazy(() => import("./pages/SocialAccounts"));
const ReplayAnalysisImport = lazy(() => import("./pages/ReplayAnalysisImport"));


export default function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/" element={<PublicLivePage />} />
          <Route path="/live/:liveId" element={<PublicLivePage />} />
          <Route path="/replays" element={<PublicReplayPage />} />
          <Route path="/replays/:replayId" element={<PublicReplayPage />} />
          <Route path="/daily" element={<PublicDailyPage />} />
            <Route path="/s/:code" element={<PublicSocialPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route element={<AuthGuard />}>
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<DashboardPage />} />
              <Route path="live" element={<AdminLivePage />} />
              <Route path="archive" element={<ArchivePage />} />
              <Route path="archive/:id" element={<RecordingDetail />} />
              <Route path="replay-audit" element={<ReplayAudit />} />
              <Route path="replay-analysis" element={<ReplayAnalysisImport />} />
              <Route path="analysis-settings" element={<AnalysisSettings />} />
              <Route path="notify" element={<NotifySettings />} />
              <Route path="search" element={<SubtitleSearch />} />
              <Route path="social" element={<SocialAccountsPage />} />
              {/* Retired tools: preserve old bookmarks without loading obsolete pages. */}
              <Route path="cover-settings" element={<Navigate to="/admin/archive" replace />} />
              <Route path="room-voice" element={<Navigate to="/admin/pocket48" replace />} />
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
