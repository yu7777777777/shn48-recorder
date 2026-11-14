import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  IconArrowLeft,
  IconEye,
  IconEyeOff,
  IconTv,
} from "../components/Icons";
import { adminApi, errorMessage, payload } from "../lib/api";

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const notice = location.state?.notice;

  useEffect(() => {
    adminApi
      .get("/auth/session")
      .then((response) => {
        const session =
          response?.data?.authenticated !== undefined
            ? response.data
            : payload(response, {});
        if (session?.authenticated !== false) {
          navigate("/admin/overview", { replace: true });
        }
      })
      .catch(() => undefined);
  }, [navigate]);

  async function submit(event) {
    event.preventDefault();
    if (!username.trim() || !password) return setError("请输入管理员账号和密码");
    setLoading(true);
    setError("");
    try {
      await adminApi.post("/auth/login", {
        username: username.trim(),
        password,
        rememberMe,
      });
      const destination = location.state?.from?.startsWith("/admin")
        ? location.state.from
        : "/admin/overview";
      navigate(destination, { replace: true });
    } catch (requestError) {
      setError(errorMessage(requestError, "账号或密码不正确"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <main className="login-card">
        <div className="login-brand">
          <div className="brand-mark">
            <IconTv size={18} />
          </div>
          <div className="brand-text">
            <span>48tools</span>
            <em>CONSOLE</em>
          </div>
        </div>

        <div className="login-heading">
          <span className="eyebrow">ADMIN CONSOLE</span>
          <h1>管理登录</h1>
          <p>录制、自动监控与 B站草稿发布仅限管理员访问。</p>
        </div>

        {notice && (
          <div
            className="toast-card toast-success"
            style={{ marginBottom: "20px" }}
            role="status"
          >
            <div className="toast-message">{notice}</div>
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="username">管理员账号</label>
            <div style={{ position: "relative" }}>
              <input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="输入管理员账号"
                autoFocus
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="password">密码</label>
            <div style={{ position: "relative" }}>
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码"
                style={{ paddingRight: "40px" }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                style={{
                  position: "absolute",
                  right: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-muted)",
                }}
              >
                {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
          </div>

          <label className="login-remember">
            <input
              type="checkbox"
              name="rememberMe"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
            />
            <span>记住登录 <span className="login-remember-duration">（30 天）</span></span>
          </label>

          {error && (
            <div
              className="toast-card toast-error"
              style={{ marginBottom: "16px" }}
              role="alert"
            >
              <div className="toast-message">{error}</div>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={loading}
          >
            {loading ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="spinner" />
                <span>正在验证…</span>
              </div>
            ) : (
              "进入管理后台"
            )}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: "20px" }}>
          <button
            type="button"
            className="text-button"
            onClick={() => navigate("/")}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <IconArrowLeft size={14} />
            <span>返回公开直播页</span>
          </button>
        </div>
      </main>
    </div>
  );
}
