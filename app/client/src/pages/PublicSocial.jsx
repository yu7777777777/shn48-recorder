import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import PlatformIcon, { brandOf } from "../components/PlatformIcon";
import PublicMediaTabs from "../components/PublicMediaTabs";
import { errorMessage, payload, publicApi } from "../lib/api";

const TEXT = {
  zh: {
    loading: "正在打开分享资料…",
    invalid: "邀请链接无效或已过期",
    invalidHint: "请向分享者索取新的链接。",
    heading: (name) => `${name} 的社交账号`,
    subtitle: "临时分享页面，到期自动失效。",
    empty: "暂无登记的公开账号",
    list: "账号列表",
    open: "打开主页",
    groups: { weibo_group: "微博群", qq: "QQ群", wechat: "微信群", fanqie: "番茄/应援会", other: "应援群" },
  },
  en: {
    loading: "Opening shared profile…",
    invalid: "This invite link is invalid or has expired",
    invalidHint: "Ask whoever shared it for a new link.",
    heading: (name) => `${name} on social media`,
    subtitle: "Shared link — expires automatically.",
    empty: "This member has no accounts on file yet",
    list: "Accounts",
    open: "Open profile",
    groups: { weibo_group: "Weibo group", qq: "QQ group", wechat: "WeChat group", fanqie: "Fan club", other: "Fan group" },
  },
};

export const SOCIAL_TEXT = TEXT;

export function languageOf(languages) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return typeof first === "string" && /^en\b/i.test(first) ? "en" : "zh";
}

export default function PublicSocial({ languages } = {}) {
  const text = TEXT[languageOf(languages ?? (typeof navigator === "undefined" ? "zh" : navigator.languages || navigator.language))];
  const { code } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    publicApi
      .get(`/social/${encodeURIComponent(code || "")}`, { cache: "no-store" })
      .then((response) => { if (alive) setData(payload(response, null)); })
      .catch((reason) => { if (alive) setError(errorMessage(reason, text.invalid)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code, text.invalid]);

  return (
    <div className="public-site">
      <PublicMediaTabs />
      <main className="public-main">
        <div className="page public-social public-social-shell">
          {loading ? (
            <LoadingState text={text.loading} label={text.loading} />
          ) : error || !data ? (
            <EmptyState title={text.invalid} detail={text.invalidHint} description={text.invalidHint} />
          ) : (
            <>
              <header className="public-social-head">
                <h1>{text.heading(data.memberName)}</h1>
                <p>{text.subtitle}</p>
              </header>
              {!Array.isArray(data.accounts) || data.accounts.length === 0 ? (
                <EmptyState title={text.empty} />
              ) : (
                <ul className="public-social-list" aria-label={text.list}>
                  {data.accounts.map((item, index) => {
                    const brand = brandOf(item.platform);
                    const groupLabel =
                      typeof item.groupKind === "string" && item.groupKind.startsWith("other:")
                        ? item.groupKind.slice(6) || text.groups.other
                        : text.groups[item.groupKind] || item.groupKind || text.groups.other;
                    return (
                      <li key={`${item.platform}-${item.accountId}-${index}`}>
                        <PlatformIcon platform={item.platform} size={20} />
                        <div className="public-social-info">
                          <div className="public-social-title-row">
                            <strong>{item.accountName || item.accountId}</strong>
                            <span className="public-social-platform">
                              {item.platform === "group" ? groupLabel : brand.label}
                            </span>
                          </div>
                          {item.platform === "group" ? null : (
                            <code className="public-social-id">{item.accountId}</code>
                          )}
                        </div>
                        {item.profileUrl ? (
                          <a
                            className="btn btn-secondary btn-sm"
                            href={item.profileUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {text.open}
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
