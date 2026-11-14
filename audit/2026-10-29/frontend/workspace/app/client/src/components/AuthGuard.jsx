import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { adminApi, payload } from "../lib/api";
import LoadingState from "./LoadingState";

export default function AuthGuard() {
  const [state, setState] = useState("checking");
  const location = useLocation();

  useEffect(() => {
    let active = true;
    adminApi.get("/auth/session")
      .then(response => {
        const session = response?.data?.authenticated !== undefined ? response.data : payload(response, {});
        // Fail closed. This used to read `=== false ? "guest" : "ready"`, so only
        // an explicit `false` was refused: an empty `{}`, a missing field, or a
        // field renamed on the server all granted access to every admin route.
        // `/auth/session` answers with `authenticated: true` on success and a 401
        // otherwise, so require that positive assertion.
        if (active) setState(session?.authenticated === true ? "ready" : "guest");
      })
      .catch(() => { if (active) setState("guest"); });
    return () => { active = false; };
  }, []);

  if (state === "checking") {
    return <div className="auth-loading"><LoadingState text="正在确认管理权限…" /></div>;
  }
  if (state === "guest") {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
