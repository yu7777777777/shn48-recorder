import React, { useEffect, useState } from "react";
import { StatusBadge } from "../components/Badge";
import Backup115Settings from "../components/Backup115Settings";
import {
  IconActivity,
  IconArchive,
  IconBilibili,
  IconCheck,
  IconFilm,
  IconRadio,
  IconRefresh,
  IconSettings,
  IconShield,
  IconTv,
} from "../components/Icons";
import { useToast } from "../components/Toast";
import { adminApi, errorMessage, payload } from "../lib/api";

export default function ConfigPage() {
  const [config, setConfig] = useState({});
  const [environment, setEnvironment] = useState({ ffmpeg: null, playwright: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    Promise.allSettled([
      adminApi.get("/config"),
      adminApi.get("/config/test-ffmpeg"),
      adminApi.get("/config/test-playwright"),
    ]).then(([configResult, ffmpegResult, playwrightResult]) => {
      if (configResult.status === "fulfilled") {
        setConfig(payload(configResult.value, {}));
      } else {
        toast.error(errorMessage(configResult.reason, "配置读取失败"));
      }
      setEnvironment({
        ffmpeg:
          ffmpegResult.status === "fulfilled"
            ? payload(ffmpegResult.value, {})
            : { available: false },
        playwright:
          playwrightResult.status === "fulfilled"
            ? payload(playwrightResult.value, {})
            : { available: false },
      });
      setLoading(false);
    });
  }, []);

  function setValue(path, value) {
    setConfig((previous) => {
      const next = { ...previous };
      let cursor = next;
      path.forEach((key, index) => {
        if (index === path.length - 1) {
          cursor[key] = value;
        } else {
          cursor[key] = { ...(cursor[key] || {}) };
          cursor = cursor[key];
        }
      });
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const response = await adminApi.put("/config", config);
      setConfig(payload(response, config));
      toast.success("系统设置已保存");
    } catch (requestError) {
      toast.error(errorMessage(requestError, "设置保存失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>系统设置</h1>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={loading || saving}
        >
          {saving ? "正在保存…" : "保存设置"}
        </button>
      </div>

      {/* Environment & Security Boundary Info */}
      <div className="grid-2" style={{ marginBottom: "20px" }}>
        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>运行组件检查</h2>
            </div>
          </div>
          <div className="grid-2">
            <div
              style={{
                padding: "14px",
                background: "var(--bg-panel)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <strong style={{ display: "block", fontSize: "14px" }}>FFmpeg</strong>
                <small style={{ color: "var(--text-muted)", fontSize: "11px" }}>音视频录制与转封装</small>
              </div>
              <StatusBadge status={environment.ffmpeg?.available ? "healthy" : "failed"}>
                {environment.ffmpeg?.available ? "可用" : "未检测到"}
              </StatusBadge>
            </div>

            <div
              style={{
                padding: "14px",
                background: "var(--bg-panel)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <strong style={{ display: "block", fontSize: "14px" }}>Playwright</strong>
                <small style={{ color: "var(--text-muted)", fontSize: "11px" }}>页面渲染与辅助抓取</small>
              </div>
              <StatusBadge status={environment.playwright?.available ? "healthy" : "failed"}>
                {environment.playwright?.available ? "可用" : "未检测到"}
              </StatusBadge>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>系统安全边界</h2>
            </div>
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-muted)", fontSize: "13px", lineHeight: "1.8" }}>
            <li>公开端只暴露短期受控播放流，不向外返回原始 RTMP/VOD 签名地址</li>
            <li>所有管理接口必须携带经服务端校验的有效管理员会话 Cookie</li>
            <li>录像文件存放在私有持久化挂载卷，不向公开静态目录暴露</li>
          </ul>
        </section>
      </div>

      {/* Playback Priority Strategy */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div className="card-title-row">
          <div>
            <h2>公开直播播放策略</h2>
          </div>
        </div>

        <div className="playback-choice-grid">
          <label
            className={`playback-choice ${
              config.playback?.livePriority !== "server" ? "selected" : ""
            }`}
          >
            <input
              type="radio"
              name="live-playback-priority"
              value="direct_first"
              checked={config.playback?.livePriority !== "server"}
              onChange={() => setValue(["playback", "livePriority"], "direct_first")}
            />
            <div>
              <strong>直连优先（推荐）</strong>
              <small>
                HTTP FLV / HLS 默认直连官方 CDN，节省服务器带宽；连接失败时自动申请服务器中转代理。
              </small>
            </div>
          </label>

          <label
            className={`playback-choice ${
              config.playback?.livePriority === "server" ? "selected" : ""
            }`}
          >
            <input
              type="radio"
              name="live-playback-priority"
              value="server"
              checked={config.playback?.livePriority === "server"}
              onChange={() => setValue(["playback", "livePriority"], "server")}
            />
            <div>
              <strong>全量服务器中转</strong>
              <small>
                所有直播统一由服务器拉流并分发给观看者，抗网络风控能力更强，但会持续消耗服务器上行带宽。
              </small>
            </div>
          </label>
        </div>

        <div style={{ marginTop: "14px", fontSize: "12px", color: "var(--text-dim)", lineHeight: 1.5 }}>
          RTMP 直播由服务器转封装为 HLS 后播放。
        </div>
      </section>

      {/* Recording Storage Settings */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div className="card-title-row">
          <div>
            <h2>录制与归档目录</h2>
          </div>
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label>口袋48 录像存储目录</label>
            <input
              value={config.pocket48?.live?.downloadDir || ""}
              onChange={(e) =>
                setValue(["pocket48", "live", "downloadDir"], e.target.value)
              }
              placeholder=".download_dir/live"
            />
          </div>
          <div className="form-group">
            <label>FFmpeg 命令路径</label>
            <input
              value={config.ffmpeg || "ffmpeg"}
              onChange={(e) => setValue(["ffmpeg"], e.target.value)}
              placeholder="ffmpeg"
            />
          </div>
        </div>
      </section>

      {/* Bilibili Default Settings */}
      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>B站草稿默认参数</h2>
          </div>
          <span className="badge badge-draft">草稿箱模式</span>
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label>默认投稿分区 ID (TID)</label>
            <input
              type="number"
              value={config.default_tid ?? config.bilibili?.defaultTid ?? 171}
              onChange={(e) =>
                setValue(
                  config.bilibili ? ["bilibili", "defaultTid"] : ["default_tid"],
                  Number(e.target.value)
                )
              }
            />
          </div>
          <div className="form-group">
            <label>默认标签（用逗号分隔）</label>
            <input
              value={config.default_tags ?? config.bilibili?.defaultTags ?? ""}
              onChange={(e) =>
                setValue(
                  config.bilibili ? ["bilibili", "defaultTags"] : ["default_tags"],
                  e.target.value
                )
              }
              placeholder="SNH48,口袋48,直播录像"
            />
          </div>
        </div>

        <div className="form-group">
          <label>默认视频简介</label>
          <textarea
            rows={3}
            value={config.default_desc ?? config.bilibili?.defaultDescription ?? ""}
            onChange={(e) =>
              setValue(
                config.bilibili ? ["bilibili", "defaultDescription"] : ["default_desc"],
                e.target.value
              )
            }
            placeholder="填写推送到 B站草稿箱时的默认描述信息"
          />
        </div>

        <label className="toggle-row">
          <div>
            <strong>录制归档完成后自动送入 B站草稿上传队列</strong>
            <small>开启后无需手动点击，只保存为草稿箱，仍需人工在 B站审核并发布</small>
          </div>
          <input
            type="checkbox"
            style={{ width: "20px", height: "20px", accentColor: "var(--accent)" }}
            checked={
              config.auto_upload_bili ?? config.bilibili?.autoUpload ?? false
            }
            onChange={(e) =>
              setValue(
                config.bilibili ? ["bilibili", "autoUpload"] : ["auto_upload_bili"],
                e.target.checked
              )
            }
          />
        </label>
      </section>
      <Backup115Settings />
    </div>
  );
}
