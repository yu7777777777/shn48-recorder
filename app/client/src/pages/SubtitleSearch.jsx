import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "../components/Toast";

const stamp = value => new Date(Math.max(0, Number(value) || 0) * 1000).toISOString().slice(11, 19);

function highlight(text, query) {
  const raw = String(text || "");
  const index = raw.toLowerCase().indexOf(String(query).toLowerCase());
  if (index < 0) return raw;
  return <>{raw.slice(0, index)}<mark>{raw.slice(index, index + query.length)}</mark>{raw.slice(index + query.length)}</>;
}

// 跨归档字幕全文搜索："这句话是哪场直播说的"。命中后跳转对应归档并定位到时间点。
export default function SubtitleSearch() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [query, setQuery] = useState(params.get("q") || "");
  const [member, setMember] = useState("");
  const [state, setState] = useState({ loading: false, data: null, error: "" });
  const requestId = useRef(0);

  const run = async (keyword, memberFilter) => {
    const trimmed = String(keyword || "").trim();
    if (!trimmed) return;
    const token = ++requestId.current;
    setState(current => ({ ...current, loading: true, error: "" }));
    try {
      const response = await adminApi.get("/analysis/search", { params: { q: trimmed, ...(memberFilter ? { member: memberFilter } : {}), limit: 60 }, timeout: 60000 });
      if (token !== requestId.current) return;
      setState({ loading: false, data: payload(response), error: "" });
    } catch (err) {
      if (token !== requestId.current) return;
      setState({ loading: false, data: null, error: errorMessage(err, "搜索失败") });
    }
  };

  // Deep link support: /admin/search?q=... runs the search on mount.
  const initial = useRef(false);
  useEffect(() => {
    if (initial.current) return;
    initial.current = true;
    const q = params.get("q");
    if (q) void run(q, "");
  }, [params]);

  function submit(event) {
    event.preventDefault();
    setParams(query.trim() ? { q: query.trim() } : {});
    void run(query, member);
  }

  const data = state.data;
  return <div>
    <div className="page-header admin-page-header">
      <div>
        <h1>字幕搜索</h1>
        <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
          跨归档全文搜索所有字幕：输入一句话，找到它是哪场直播、哪个时间点说的，点击直接跳转播放。
        </p>
      </div>
    </div>
    <form className="card" style={{ marginBottom: 20, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={submit}>
      <div className="form-group" style={{ flex: "2 1 260px", marginBottom: 0 }}>
        <label>关键词</label>
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：谢谢大家 / 生日快乐 / 官宣" />
      </div>
      <div className="form-group" style={{ flex: "1 1 160px", marginBottom: 0 }}>
        <label>成员过滤（可选）</label>
        <input value={member} onChange={e => setMember(e.target.value)} placeholder="成员名包含…" />
      </div>
      <button type="submit" className="btn btn-primary" disabled={state.loading || !query.trim()}>{state.loading ? "搜索中…" : "搜索"}</button>
    </form>

    {state.error && <p className="detail-error" role="alert">{state.error}</p>}
    {data && !state.error && <>
      <p style={{ color: "var(--text-muted)" }}>
        {data.recordingsHit > 0
          ? <>在 <strong>{data.recordingsHit}</strong> 场直播中找到 <strong>{data.totalMatches}</strong> 处「{data.query}」{data.truncated ? "（结果已截断，可补充成员或更具体的关键词缩小范围）" : ""}</>
          : <>没有找到包含「{data.query}」的字幕。</>}
      </p>
      {data.results?.map(row => <section key={row.recordingId} className="card" style={{ marginBottom: 16 }}>
        <div className="card-title-row">
          <div>
            <h2 style={{ fontSize: 16 }}><Link to={`/admin/archive/${row.recordingId}`}>{row.title || "未命名录像"}</Link></h2>
            <small style={{ color: "var(--text-muted)" }}>
              {row.memberName || "未知成员"} · {new Date(row.date).toLocaleDateString("zh-CN")} · {row.matches.length} 处命中
            </small>
          </div>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          {row.matches.map(match => <div key={match.index} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "6px 10px", background: "var(--bg-panel)", borderRadius: "var(--radius)" }}>
            <Link to={`/admin/archive/${row.recordingId}?t=${Math.max(0, Math.floor(match.start - 5))}`} style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{stamp(match.start)}</Link>
            <span>{highlight(match.text, data.query)}</span>
          </div>)}
        </div>
      </section>)}
    </>}
  </div>;
}
