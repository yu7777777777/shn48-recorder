import React from "react";
import { Link } from "react-router-dom";
import { IconFilm, IconRadio } from "./Icons";

export default function PublicMediaTabs({ active, liveCount }) {
  return (
    <nav className="public-media-tabs" aria-label="公开内容分类">
      <Link
        className={active === "live" ? "active" : ""}
        to="/"
        aria-current={active === "live" ? "page" : undefined}
      >
        <IconRadio size={16} />
        <span>正在直播</span>
        {liveCount !== undefined && liveCount > 0 && (
          <span className="badge badge-recording" style={{ fontSize: "10px", padding: "1px 6px" }}>
            {liveCount}
          </span>
        )}
      </Link>
      <Link
        className={active === "replay" ? "active" : ""}
        to="/replays"
        aria-current={active === "replay" ? "page" : undefined}
      >
        <IconFilm size={16} />
        <span>往期重播</span>
      </Link>
    </nav>
  );
}
