import React from "react";
import { Link } from "react-router-dom";
import { IconFilm, IconRadio, IconTv } from "./Icons";
import "../styles/PublicSite.css";

export default function PublicMediaTabs({ active, liveCount, extra = null }) {
  return (
    <header className="public-header">
      <div className="public-header-inner">
        <Link to="/" className="public-brand">
          <div className="public-brand-logo">
            <IconTv size={16} />
          </div>
          <span>48tools</span>
        </Link>

        <nav className="public-media-tabs" aria-label="公开内容分类">
          <Link
            className={`public-media-tab ${active === "live" ? "active" : ""}`}
            to="/"
            aria-current={active === "live" ? "page" : undefined}
          >
            <IconRadio size={15} />
            <span>正在直播</span>
            {liveCount !== undefined && liveCount > 0 && (
              <span className="public-tab-count">{liveCount}</span>
            )}
          </Link>
          <Link
            className={`public-media-tab ${active === "replay" ? "active" : ""}`}
            to="/replays"
            aria-current={active === "replay" ? "page" : undefined}
          >
            <IconFilm size={15} />
            <span>往期重播</span>
          </Link>
          <Link
            className={`public-media-tab ${active === "daily" ? "active" : ""}`}
            to="/daily"
            aria-current={active === "daily" ? "page" : undefined}
          >
            <IconFilm size={15} />
            <span>总结日报</span>
          </Link>
        </nav>

        <div className="public-header-extra">{extra}</div>
      </div>
    </header>
  );
}
