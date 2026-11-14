import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage, payload, publicApi } from "../lib/api";
import LoadingState from "../components/LoadingState";
import EmptyState from "../components/EmptyState";
import PublicMediaTabs from "../components/PublicMediaTabs";
import "../styles/PublicSite.css";
import "./PublicReplay.css";

// 公开总结日报：把已发布的 AI 总结按日期聚合，访客可以浏览"最近几天的直播
// 都聊了什么"。RSS 订阅地址在页头给出，方便用阅读器追更。
export default function PublicDaily() {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  useEffect(() => {
    let alive = true;
    publicApi.get("/daily", { timeout: 30000 })
      .then(response => { if (alive) setState({ loading: false, data: payload(response), error: "" }); })
      .catch(error => { if (alive) setState({ loading: false, data: null, error: errorMessage(error, "日报加载失败") }); });
    return () => { alive = false; };
  }, []);

  if (state.loading) return <div className="public-site"><PublicMediaTabs active="daily" /><main className="public-main"><LoadingState /></main></div>;
  if (state.error) return <div className="public-site"><PublicMediaTabs active="daily" /><main className="public-main"><EmptyState title="日报暂时不可用" description={state.error} /></main></div>;
  const digest = state.data;
  if (!digest?.published) return <div className="public-site"><PublicMediaTabs active="daily" /><main className="public-main"><EmptyState title="总结日报未开放" description="管理员尚未开启总结发布。" /></main></div>;

  return <div className="public-site">
    <PublicMediaTabs active="daily" />
    <main className="public-main daily-page">
    <header className="daily-header">
      <h1>直播总结日报</h1>
      <p>最近几天的直播都聊了什么——已发布的 AI 总结按日期聚合。</p>
      <a className="daily-rss" href="/api/public/daily/rss">RSS 订阅</a>
    </header>
    {!digest.days.length ? <EmptyState title="还没有已发布的总结" description="有直播总结发布后会出现在这里。" /> :
      <div className="daily-days">
        {digest.days.map(day => <section key={day.date} className="daily-day">
          <h2>{day.date}</h2>
          {day.items.map(item => <article key={item.recordingId} className="daily-item">
            <h3>
              {item.liveId
                ? <Link to={`/replays/${encodeURIComponent(item.liveId)}`}>{item.memberName ? `${item.memberName} · ` : ""}{item.title}</Link>
                : <span>{item.memberName ? `${item.memberName} · ` : ""}{item.title}</span>}
            </h3>
            <time>{new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false })}</time>
            <p>{item.summary.length >= 1200 ? `${item.summary.slice(0, 1200)}…` : item.summary}</p>
            {item.liveId && <Link className="daily-more" to={`/replays/${encodeURIComponent(item.liveId)}`}>查看回放与完整总结 →</Link>}
          </article>)}
        </section>)}
      </div>}
    </main>
  </div>;
}
