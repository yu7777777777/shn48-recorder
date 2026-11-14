import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconCheck,
  IconEye,
  IconEyeOff,
  IconLock,
  IconShield,
  IconUser,
} from "../components/Icons";
import ProgressBar from "../components/ProgressBar";
import { useToast } from "../components/Toast";
import { passwordStrength, validateAdminCredentials } from "../lib/adminCredentials";
import { adminApi, errorMessage, payload } from "../lib/api";

const EMPTY_FORM = {
  currentPassword: "",
  newUsername: "",
  newPassword: "",
  confirmPassword: "",
};

function PasswordField({
  id,
  label,
  value,
  error,
  visible,
  onToggle,
  onChange,
  autoComplete,
  placeholder,
}) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          placeholder={placeholder}
          style={{ paddingRight: "40px" }}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${visible ? "隐藏" : "显示"}${label}`}
          style={{
            position: "absolute",
            right: "12px",
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--text-muted)",
          }}
        >
          {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
      {error && (
        <span
          style={{
            color: "var(--danger)",
            fontSize: "12px",
            marginTop: "4px",
            display: "block",
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

export default function SecurityPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_FORM);
  const [visible, setVisible] = useState({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    adminApi
      .get("/auth/session")
      .then((response) => {
        const session =
          response?.data?.authenticated !== undefined
            ? response.data
            : payload(response, {});
        const username = session?.data?.username ?? session?.username ?? "";
        if (active) setForm((previous) => ({ ...previous, newUsername: username }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const strength = useMemo(
    () => passwordStrength(form.newPassword),
    [form.newPassword]
  );

  function updateField(field, value) {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({
      ...previous,
      [field]: "",
      ...(field === "newPassword" ? { confirmPassword: "" } : {}),
    }));
  }

  function toggleVisibility(field) {
    setVisible((previous) => ({ ...previous, [field]: !previous[field] }));
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validateAdminCredentials(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSaving(true);
    try {
      await adminApi.put("/auth/credentials", {
        currentPassword: form.currentPassword,
        newUsername: form.newUsername.trim(),
        newPassword: form.newPassword,
      });
      toast.success("管理员账号密码已更新，请重新登录");
      navigate("/admin/login", {
        replace: true,
        state: { notice: "管理员账号密码已更新，请使用新凭据重新登录。" },
      });
    } catch (requestFailure) {
      toast.error(errorMessage(requestFailure, "账号密码修改失败，请稍后重试"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h1>账户安全</h1>
          <p>修改管理员登录账号和密码，保障私有录制与发布权限。</p>
        </div>
        <span className="badge badge-done">
          <IconShield size={12} />
          <span>仅管理员可操作</span>
        </span>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>修改管理员登录凭据</h2>
              <p>提交保存后所有已有会话将立即失效，需使用新账号密码重新登录</p>
            </div>
            <IconLock size={18} color="var(--accent-hover)" />
          </div>

          <form onSubmit={submit} noValidate>
            <PasswordField
              id="current-password"
              label="当前旧密码"
              value={form.currentPassword}
              error={errors.currentPassword}
              visible={visible.currentPassword}
              onToggle={() => toggleVisibility("currentPassword")}
              onChange={(e) => updateField("currentPassword", e.target.value)}
              autoComplete="current-password"
              placeholder="输入当前密码以确认身份"
            />

            <div
              style={{
                margin: "20px 0 16px",
                borderTop: "1px solid var(--border-soft)",
                paddingTop: "16px",
                fontSize: "12px",
                fontWeight: 700,
                color: "var(--accent-hover)",
              }}
            >
              新的登录凭据
            </div>

            <div className="form-group">
              <label htmlFor="new-username">新的管理员账号</label>
              <input
                id="new-username"
                value={form.newUsername}
                onChange={(e) => updateField("newUsername", e.target.value)}
                autoComplete="username"
                placeholder={loading ? "正在读取…" : "输入新的管理员账号"}
                disabled={loading}
              />
              {errors.newUsername ? (
                <span style={{ color: "var(--danger)", fontSize: "12px", marginTop: "4px", display: "block" }}>
                  {errors.newUsername}
                </span>
              ) : (
                <span style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "4px", display: "block" }}>
                  保留当前内容可只修改密码
                </span>
              )}
            </div>

            <PasswordField
              id="new-password"
              label="新密码"
              value={form.newPassword}
              error={errors.newPassword}
              visible={visible.newPassword}
              onToggle={() => toggleVisibility("newPassword")}
              onChange={(e) => updateField("newPassword", e.target.value)}
              autoComplete="new-password"
              placeholder="至少 10 个字符"
            />

            {form.newPassword && (
              <div style={{ marginBottom: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "4px" }}>
                  <span style={{ color: "var(--text-muted)" }}>密码安全强度</span>
                  <span style={{ fontWeight: 700, color: strength.score >= 3 ? "var(--success)" : "var(--warning)" }}>
                    {strength.label}
                  </span>
                </div>
                <ProgressBar
                  percent={(strength.score / 4) * 100}
                  tone={
                    strength.score >= 3
                      ? "success"
                      : strength.score === 2
                      ? "warning"
                      : "danger"
                  }
                  height={5}
                />
              </div>
            )}

            <PasswordField
              id="confirm-password"
              label="再次确认新密码"
              value={form.confirmPassword}
              error={errors.confirmPassword}
              visible={visible.confirmPassword}
              onToggle={() => toggleVisibility("confirmPassword")}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
              autoComplete="new-password"
              placeholder="再次输入新密码"
            />

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: "100%", marginTop: "12px" }}
              disabled={saving}
            >
              {saving ? "正在更新凭据…" : "确认修改并重新登录"}
            </button>
          </form>
        </section>

        {/* Security Checklist & Best Practices */}
        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>安全规则与要求</h2>
              <p>系统强制执行的安全基线</p>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px", color: "var(--text-soft)" }}>
            <div className="inset-panel">
              <strong style={{ display: "block", color: "var(--text-main)", marginBottom: "4px" }}>
                密码强度规则
              </strong>
              <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>
                <li>长度要求 10 – 256 个字符</li>
                <li>至少包含大写字母、小写字母、数字或符号中的两种组合</li>
                <li>不能与用户名或当前密码相同</li>
              </ul>
            </div>

            <div className="inset-panel">
              <strong style={{ display: "block", color: "var(--text-main)", marginBottom: "4px" }}>
                凭据存储与隔离
              </strong>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.6" }}>
                密码采用 scrypt 哈希加盐计算，安全持久化存储于 <code>runtime/data/</code> 挂载卷中，不会在任何公开接口或日志中输出明文。
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
