import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, payload, errorMessage } from '../lib/api';
import SafeImage from '../components/SafeImage';
import { useToast } from '../components/Toast';
import './Pocket48.css';
import { formatMessage, isMemberMessage } from '../lib/pocket48-message';
import { IconRefresh, IconSearch, IconUsers, IconMessageSquare, IconAlertCircle, IconCheckCircle, IconStar, IconSettings, IconX, IconCheck, IconChevronRight } from '../components/Icons';

const base = '/pocket48/account';
const list = (data, keys) => Array.isArray(data) ? data : keys.map(k => data?.[k]).find(Array.isArray) || [];
const str = value => String(value ?? '');
const folded = value => str(value).replace(/[\s·]+/g, '').toLowerCase();
// Pocket48 often reports the room name as the member's own name, which printed
// as "王妃 · 王妃的房间". Drop the repeated half instead of showing it twice.
const roomLabel = room => {
  const owner = str(room?.ownerName).trim();
  const name = str(room?.roomName).trim();
  const parts = [owner, name && name !== owner && folded(name) !== folded(owner) ? name : ''].filter(Boolean);
  return parts.join(' · ') || str(room?.roomId);
};
// Kept for the check-in card, which prints a full timestamp.
function time(value) { const n = Number(value); const d = new Date(n ? (n < 1e12 ? n * 1000 : n) : value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN'); }

// A transcript printed the full locale timestamp on every row, which made the
// stamp visually louder than the message. Group by day and show a clock only.
function toDate(value) { const n = Number(value); const d = new Date(n ? (n < 1e12 ? n * 1000 : n) : value); return Number.isNaN(d.getTime()) ? null : d; }
const dayKey = value => { const d = toDate(value); return d ? str(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; };
const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayLabel(key) {
  if (!key) return '时间未知';
  const d = new Date(key + 'T00:00:00');
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000);
  if (key === today) return '今天 · ' + key + ' ' + dayNames[d.getDay()];
  if (key === yesterday) return '昨天 · ' + key + ' ' + dayNames[d.getDay()];
  return key + ' ' + dayNames[d.getDay()];
}
function clock(value) { const d = toDate(value); return d ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; }

function Messages({ items, ownerId, note }) {
  return items.length ? <div className="p48-messages">{items.map((msg, i) => {
    const formatted = formatMessage(msg);
    const stamp = msg.msgTime || msg.messageTime || msg._receivedAt;
    const previous = items[i - 1] && (items[i - 1].msgTime || items[i - 1].messageTime || items[i - 1]._receivedAt);
    const member = isMemberMessage(msg, ownerId);
    const kind = member ? 'member' : msg._source === 'notifications' ? 'notify' : 'fan';
    return <React.Fragment key={str(msg._roomId) + ':' + str(msg.msgIdClient || msg.msgidClient || msg.msgId || msg.msgTime) + ':' + i}>
      {dayKey(stamp) !== dayKey(previous) && <div className="p48-day"><span>{dayLabel(dayKey(stamp))}</span></div>}
      <article className={'p48-msg p48-msg-' + kind}>
        <div className="p48-message-meta"><strong>{formatted.senderName}{msg._roomName ? ' · ' + msg._roomName : ''}</strong><time dateTime={str(stamp)} title={time(stamp)}>{clock(stamp)}</time></div>
        <div className={'p48-bubble' + (member ? ' p48-bubble-member' : '') + (msg._source === 'notifications' ? ' p48-bubble-notification' : '')}>
          {formatted.label && <small className="p48-message-label">{formatted.label}</small>}
          {formatted.question && <blockquote className="p48-question">提问：{formatted.question}</blockquote>}
          {formatted.text && <p>{formatted.text}</p>}
          {formatted.mediaType === 'image' && <a href={formatted.mediaUrl} target="_blank" rel="noreferrer"><img className="p48-message-image" src={formatted.mediaUrl} alt="房间图片消息" loading="lazy" /></a>}
          {formatted.mediaType === 'audio' && <audio controls preload="none" src={formatted.mediaUrl} />}
          {formatted.mediaType === 'video' && <video controls preload="none" src={formatted.mediaUrl} />}
        </div>
      </article>
    </React.Fragment>;
  })}{note && <p className="p48-history-end">{note}</p>}</div> : <div className="p48-empty">暂无可读取的消息。</div>;
}

// Two side-by-side transcripts asked the reader to compare columns to answer one
// question ("what did the member say, without the fan noise?"). That is a filter,
// not a second pane, so the two streams became one list with a scope switch.
const scopes = [
  { id: 'all', title: '全部消息', hint: '成员＋粉丝的全部聊天' },
  { id: 'members', title: '仅成员', hint: '只看成员发言 · 直播 · 翻牌' },
];
const STICK_SLACK = 40;

// "看不到任何消息" has several very different causes (an empty room, a paging
// bug, a session that expired, an upstream endpoint that now answers with rows
// somewhere else). Guessing wastes a round trip through the operator, so the
// stream keeps the last exchange and offers a button that asks the server to
// probe every known message endpoint for the SAME room and shows the result.
function Diagnose({ room, trace }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!room || busy) return;
    setBusy(true); setReport(null);
    try { setReport({ ok: true, at: new Date().toISOString(), data: payload(await adminApi.get(base + '/rooms/' + encodeURIComponent(room.roomId) + '/diagnose')) }); }
    catch (e) { setReport({ ok: false, at: new Date().toISOString(), error: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  return <details className="p48-diagnose">
    <summary>看不到消息？检查读取链路</summary>
    <div className="p48-diagnose-body">
      <button type="button" className="btn btn-secondary btn-sm" disabled={!room || busy} onClick={run}>{busy ? '正在探测…' : '探测该房间的消息接口'}</button>
      <p className="p48-diagnose-hint">依次询问成员频道流和房间流，告诉你是哪个环节没有返回数据。报告只含房间号、接口状态和条数，可直接复制反馈。</p>
      {(trace || report) && <pre className="p48-diagnose-text">{JSON.stringify({ ui: trace || null, server: report || null }, null, 2)}</pre>}
    </div>
  </details>;
}

function MessageStream({ room, scope, onTrace }) {
  const [state, setState] = useState({ items: [], next: {}, loading: false, error: '', exhausted: false, olderEmpty: false });
  const [pinned, setPinned] = useState(true);
  const [fresh, setFresh] = useState(0);
  const [older, setOlder] = useState(false);
  const timeline = useRef({}), retryOlder = useRef(false);
  const sequence = useRef(0), scroll = useRef(null), pending = useRef(false);
  const lastTop = useRef(null);

  const keyOf = m => str(m._source) + ':' + str(m.msgIdClient || m.msgidClient || m.msgId || JSON.stringify([m.msgTime, m.bodys, m.extInfo]));

  // `active` mirrors the painted list so the polling callback can diff against
  // it without widening the effect dependencies below.
  const active = useRef({ pinned: true });
  active.current = { pinned };

  const load = useCallback(async (older = false) => {
    if (!room || pending.current) return;
    pending.current = true; retryOlder.current = older;
    const id = ++sequence.current;
    setState(old => ({ ...old, loading: true, error: '' }));
    try {
      // 仅成员 merges the channel transcript (which already carries 直播通知) with the
      // separate notification room. Plenty of members have no notification room at
      // all, and failing the whole load for that turned a readable room into a red
      // error box. Sources are now independent: a missing notification room is
      // simply absent, and only a failure of the member channel itself is fatal.
      const sources = scope === 'members' ? ['members', 'notifications'] : ['all'];
      const cache = older ? structuredClone(timeline.current) : {};
      // A source that has never been paged is always in the first request: with
      // no cache entry its boundary is -Infinity, and -Infinity is never the
      // frontier, so "refresh" used to skip it and the room stayed empty until
      // the reader switched scope or paged back. Only a source that HAS a cursor
      // is gated on the frontier, so the shared timeline stays gapless.
      const paged = sources.filter(source => cache[source]?.next);
      const frontier = paged.length ? Math.max(...paged.map(source => cache[source].boundary)) : -Infinity;
      const requested = sources.filter(source => !cache[source] || !cache[source].next || cache[source].boundary === frontier);
      const trace = [];
      const results = await Promise.allSettled(requested.map(async source => {
        const previous = older ? state.next[source] : null;
        let data;
        try { data = payload(await adminApi.get(base + '/rooms/' + encodeURIComponent(room.roomId) + '/messages?scope=' + source + (previous ? '&nextTime=' + encodeURIComponent(previous) : ''))); }
        catch (e) {
          // A member with no notification room is NOT an error: the channel
          // transcript is the complete answer. Anything else still fails loudly.
          if (source === 'notifications') {
            trace.push({ source, skipped: errorMessage(e) });
            return { source, rows: [], next: null, skipped: true };
          }
          trace.push({ source, error: errorMessage(e) }); throw e;
        }
        const rows = list(data, ['message', 'messages', 'list']).map(m => ({ ...m, _source: source }));
        const value = data.nextTime || data.next;
        trace.push({ source, got: rows.length, nextTime: str(value || ''), keys: Array.isArray(data) ? ['（数组）'] : Object.keys(data || {}).slice(0, 8) });
        return { source, rows, next: rows.length && value && String(value) !== '0' && String(value) !== String(previous) ? String(value) : null };
      }));
      if (id !== sequence.current) return;
      const failures = [];
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          const { source, rows, next } = result.value;
          if (result.value.skipped) { cache[source] = { rows: [], next: null, boundary: -Infinity }; return; }
          const combined = [...(cache[source]?.rows || []), ...rows];
          const times = rows.map(m => Number(m.msgTime || m.messageTime || 0));
          cache[source] = { rows: combined, next, boundary: next ? (times.length ? Math.min(...times) : Number(next)) : -Infinity };
        } else failures.push(errorMessage(result.reason));
      });
      // A failed source must not advance the shared timeline or discard its cursor.
      if (failures.length) throw new Error(failures.join('；'));
      timeline.current = cache;
      // Every source starts empty; -Infinity would let the one just-read source
      // filter out its own rows. -Infinity means "no source has a lower bound".
      const raw = Math.max(...sources.map(source => cache[source]?.boundary ?? Infinity));
      const cutoff = Number.isFinite(raw) ? raw : -Infinity;
      const merged = sources.flatMap(source => cache[source]?.rows || []);
      const unique = [...new Map(merged.map(m => [keyOf(m), m])).values()]
        .filter(m => Number(m.msgTime || m.messageTime || 0) >= cutoff)
        .sort((a, b) => Number(b.msgTime || b.messageTime || 0) - Number(a.msgTime || a.messageTime || 0));
      // The list is newest-first and the scroller used to be reset to the top on
      // every refresh, so a reader who had scrolled into the history was yanked
      // away. Now the reading position is preserved, and arrivals are surfaced
      // as a banner the reader can accept on their own terms.
      const top = unique[0] ? keyOf(unique[0]) : null;
      // Rows returned by THIS request, so "no older rows left" is a fact about
      // the page just loaded rather than about the whole merged timeline.
      const pageRows = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.rows.length : 0), 0);
      const before = lastTop.current;
      const first = before === null;
      // `added` is how far down the old head moved, i.e. how many messages landed
      // above it. Only meaningful for a refresh, never for a load-older page.
      const added = !older && before !== null && before !== top ? unique.findIndex(m => keyOf(m) === before) : -1;
      if (added > 0 && !active.current.pinned) setFresh(n => n + added);
      lastTop.current = top;
      const next = Object.fromEntries(sources.map(source => [source, cache[source]?.next]));
      // "暂无消息" and "这已经是最早一条" look identical to a reader, so the two
      // states are kept apart: a first page with rows means the history below is
      // exhausted once every cursor is spent; a paging request that returns
      // nothing says so explicitly instead of looking like a dead button.
      const exhausted = unique.length > 0 && !Object.values(next).some(Boolean);
      setState(old => ({ items: unique, next, error: '', loading: false, exhausted, olderEmpty: older && pageRows === 0 }));
      onTrace?.({ roomId: str(room.roomId), scope, at: new Date().toISOString(), requested, trace, shown: unique.length, total: merged.length, cutoff });
      // Jump to the newest only when the reader is at the top, is already waiting
      // there via the banner, or is arriving at this column for the first time.
      if (!older && scroll.current && (first || active.current.pinned)) scroll.current.scrollTop = 0;
    } catch (e) { if (id === sequence.current) { const message = /Authentication required/i.test(errorMessage(e)) ? '网站登录已过期，请重新登录后继续读取消息。' : errorMessage(e); setState(old => ({ ...old, loading: false, error: message })); onTrace?.({ roomId: str(room?.roomId), scope, at: new Date().toISOString(), error: message }); } }
    finally { if (id === sequence.current) pending.current = false; }
  }, [room, scope, state.next]);

  // Switching scope or room restarts the timeline: the two scopes page
  // independently and their cursors cannot be carried across.
  useEffect(() => { setFresh(0); setOlder(false); lastTop.current = null; setState(old => ({ ...old, exhausted: false, olderEmpty: false })); load(); return () => { sequence.current++; pending.current = false; }; }, [room?.roomId, scope]);

  return <section className="p48-stream" aria-label={scopes.find(s => s.id === scope)?.title}>
    <div className="p48-stream-tools">
      <span className="p48-count">{state.items.length} 条</span>
      <button type="button" className="p48-refresh" aria-label="刷新消息" disabled={!room || state.loading} onClick={() => load(older)}>
        <IconRefresh size={13} aria-hidden="true" /><span>{state.loading ? '读取中…' : '刷新'}</span>
      </button>
    </div>
    <div className="p48-stream-scroll" ref={scroll} aria-busy={state.loading} tabIndex={0} aria-label="消息列表"
      onScroll={e => { const atTop = e.currentTarget.scrollTop <= STICK_SLACK; setPinned(atTop); if (atTop) setFresh(0); }}>
      {!room ? <div className="p48-empty">从左侧房间列表选择一个成员</div> : <>
        {state.error && <div className="p48-stream-error" role="alert"><IconAlertCircle size={15} aria-hidden="true" /><span>{state.error}</span><button type="button" onClick={() => load(retryOlder.current)}>重试</button></div>}
        {state.loading && !state.items.length && <p className="p48-loading" role="status">正在读取…</p>}
        {fresh > 0 && <button type="button" className="p48-fresh" onClick={() => { setPinned(true); setFresh(0); if (scroll.current) scroll.current.scrollTop = 0; }}>{fresh} 条新消息 · 回到最新</button>}
        {(state.items.length > 0 || (!state.loading && !state.error)) && <Messages items={state.items} ownerId={room?.ownerId} note={state.olderEmpty ? '这一页没有更早的消息了。' : ''} />}
      </>}
    </div>
    {/* Pinned below the scroll area rather than inside it: the control sat at the
        end of a 100-message list, so in the normal reading position it was scrolled
        out of view and only a stray dashed border peeked out at the bottom edge. */}
    {room && <div className="p48-stream-foot">
      {Object.values(state.next).some(Boolean)
        ? <button type="button" className="p48-history" disabled={state.loading} onClick={() => { setOlder(true); load(true); }}>{state.loading ? '正在读取…' : '加载更早消息'}</button>
        : state.exhausted && <p className="p48-history-end">已经读到最早一条消息</p>}
    </div>}
  </section>;
}

// The left panel is a FOLLOW MANAGER, not a room picker.
//
// The room list (`/account/rooms`) only ever contains members you already
// follow, so it can never be used to ADD one — that was the flaw in the first
// version of this page. This list is the full public member directory (531
// members, grouped by team), each row flagged with whether the logged-in
// Pocket48 account follows them, so both directions are possible.
//
// Following here is a real mutation of the Pocket48 account through
// `friendships/friends/add` and `.../remove`; it is NOT a local watch list.
const MEMBER_VIEW_KEY = 'pocket48.memberView';
const COLLAPSED_KEY = 'pocket48.collapsedTeams';
const MEMBER_VIEWS = ['all', 'followed', 'open', 'gone'];
const STAR_PREFIX = /^(SNH48|BEJ48|GNZ48|CKG48|CGT48|SHY48|IDFT)[-\uFF0D\s]*/;
const shortName = value => str(value).replace(STAR_PREFIX, '');
// two members can share a stage name, so the id disambiguates the row label
function MemberList({ groups, query, onQuery, onPick, onToggle, onMissingRoom, busyId, followedCount, goneCount, openCount, totalCount, loading, error, view, onView, selectedId, collapsed, onToggleGroup }) {
  const needle = query.trim().toLowerCase();
  // "已关注" is a VIEW of the same roster, not a second list: it filters the
  // rows already on screen, so the star, the room and the team grouping stay
  // exactly the same objects the full list renders.
  const filtered = useMemo(() => {
    const hit = m => (!needle || (str(m.ownerName) + ' ' + str(m.groupName) + ' ' + str(m.roomId) + ' ' + str(m.ownerId)).toLowerCase().includes(needle))
      && (view !== 'followed' || m.followed)
      && (view !== 'gone' || m.roomState === 'gone')
      && (view !== 'open' || m.roomState === 'ok');
    return groups.map(g => [g.teamName, g.members.filter(hit)]).filter(([, rows]) => rows.length);
  }, [groups, needle, view]);
  const total = filtered.reduce((n, [, rows]) => n + rows.length, 0);
  // Header-scoped bulk control: fold or unfold every team currently visible in
  // one click, but never fold the team holding the member being read — that
  // would make the selection vanish from the list.
  const visibleKeys = filtered.map(([team]) => team || '(无队伍)');
  const foldedVisible = visibleKeys.filter(k => collapsed.has(k)).length;
  // The team holding the member being read stays open either way: folding it
  // would make the selection disappear and look like the click did nothing.
  const heldKey = filtered.find(([, rows]) => rows.some(m => m.ownerId === selectedId))?.[0] || '(无队伍)';
  // "Everything is folded" means nothing is left to fold — counting the held
  // team as unfolded would leave the button saying "收起" after it already did.
  const allFolded = visibleKeys.length > 0 && visibleKeys.every(k => k === heldKey || collapsed.has(k));
  const expandAll = () => onToggleGroup(null);
  const foldAll = () => onToggleGroup(visibleKeys.filter(k => k !== heldKey));
  // Four scopes in one row each got ~60px on a 260px panel, so every label
  // wrapped to two lines. They now sit in a 2x2 grid: each cell keeps one line,
  // the whole block is shorter than the wrapped single row, and the filter
  // still holds only four options.
  return <>
    <div className="p48-rooms-scope" role="group" aria-label="成员范围">
      <button type="button" className={view === 'all' ? 'on' : ''} aria-pressed={view === 'all'} onClick={() => onView('all')}
        title={`全部成员（${totalCount || 0} 位）`}>
        <IconUsers size={13} aria-hidden="true" />全部<em>{totalCount || 0}</em>
      </button>
      <button type="button" className={view === 'followed' ? 'on' : ''} aria-pressed={view === 'followed'} onClick={() => onView('followed')}
        title={`已关注的成员（${followedCount || 0} 位）`}>
        <IconStar size={13} filled aria-hidden="true" />已关注<em>{followedCount || 0}</em>
      </button>
      <button type="button" className={'p48-scope-open' + (view === 'open' ? ' on' : '')} aria-pressed={view === 'open'} onClick={() => onView(view === 'open' ? 'all' : 'open')}
        title={`房间正常、能读到消息的成员（${openCount || 0} 位）`}>
        <IconCheckCircle size={13} aria-hidden="true" />正常<em>{openCount || 0}</em>
      </button>
      <button type="button" className={'p48-scope-gone' + (view === 'gone' ? ' on' : '')} aria-pressed={view === 'gone'} onClick={() => onView(view === 'gone' ? 'all' : 'gone')}
        title={`房间已被口袋48收回、读不到消息的成员（${goneCount || 0} 位），单列出来免得点进去才发现`}>
        <IconAlertCircle size={13} aria-hidden="true" />已收回<em>{goneCount || 0}</em>
      </button>
    </div>
    <div className="p48-search">
      <IconSearch size={14} aria-hidden="true" />
      <input aria-label="搜索成员" placeholder="搜索成员 / 队伍" value={query} onChange={e => onQuery(e.target.value)} />
      {query && <button type="button" className="p48-search-clear" aria-label="清除搜索" onClick={() => onQuery('')}>×</button>}
    </div>
    {filtered.length > 1 && <div className="p48-room-foldall">
      <button type="button" className="p48-foldall" onClick={allFolded ? expandAll : foldAll}>
        {allFolded ? '展开全部队伍' : '收起全部队伍'}
      </button>
      <span className="p48-foldall-count">{foldedVisible > 0 && !allFolded ? `已收起 ${foldedVisible} / ${visibleKeys.length}` : ''}</span>
    </div>}
    <div className="p48-room-list">
      {error && <p className="p48-error" role="alert">{error}</p>}
      {loading && !groups.length && <p className="p48-loading" role="status">正在读取成员名单…</p>}
      {filtered.map(([team, rows]) => {
        // 531 members grouped into 20+ teams: expanded, the list is a long scroll
        // to reach any one team. Each team header is now a real disclosure
        // (<h3><button aria-expanded>) so a team can be folded to its one-line
        // header and the whole roster fits on screen.
        const key = team || '(无队伍)';
        const folded = collapsed.has(key);
        return <div className={'p48-room-group' + (folded ? ' folded' : '')} key={key}>
          <h3 className="p48-room-group-title">
            <button type="button" className="p48-room-group-toggle" aria-expanded={!folded}
              aria-controls={'p48-group-' + key} onClick={() => onToggleGroup(key)}
              title={(folded ? '展开 ' : '收起 ') + (team || '其他')}>
              <IconChevronRight size={13} aria-hidden="true" />
              {team || '其他'}
              <span aria-label={rows.length + ' 位成员'}>{rows.length}</span>
            </button>
          </h3>
          {!folded && <div className="p48-room-group-body" id={'p48-group-' + key}>
            {rows.map(m => {
              const on = m.followed;
              const label = (team ? team + ' · ' : '') + shortName(m.ownerName);
              return <div key={m.ownerId} className={'p48-room-row' + (selectedId === m.ownerId ? ' selected' : '')}>
                {/* Never silently disable a row: a disabled button looks identical to a
                    dead page. If the directory has no room/channel id the row says so
                    when clicked instead of swallowing the click. */}
                <button type="button" className={'p48-room-open' + (m.roomState === 'gone' ? ' gone' : '')}
                  title={!m.roomId ? m.ownerName + '（暂无房间号，无法读取消息）' : m.roomState === 'gone' ? m.ownerName + '：该成员的房间已被口袋48收回，读不到消息' : m.ownerName}
                  aria-label={label + (m.roomState === 'gone' ? '，房间已收回' : '')}
                  onClick={() => m.roomId ? onPick(m) : onMissingRoom?.(m)}>
                  <strong>{shortName(m.ownerName)}</strong>
                  <span className="p48-room-id">{m.roomId || '无房间号'}</span>
                  {m.roomState === 'gone' && <span className="p48-room-gone">已收回</span>}
                </button>
                <button type="button" className={'p48-follow' + (on ? ' on' : '')} disabled={busyId === m.ownerId}
                  aria-pressed={on} title={on ? '取消关注' : '关注'}
                  aria-label={(on ? '取消关注 ' : '关注 ') + label} onClick={() => onToggle(m)}>
                  <IconStar size={14} filled={on} aria-hidden="true" />
                </button>
              </div>;
            })}
          </div>}
        </div>;
      })}
      {!loading && !total && <p className="p48-empty">{!groups.length ? '登录后加载成员名单。' : view === 'followed' ? (needle ? '已关注成员里没有匹配项' : '还没有关注任何成员，点星标即可关注。') : view === 'gone' ? '没有被收回房间的成员' : view === 'open' ? '没有房间正常的成员' : '没有匹配的成员'}</p>}
    </div>
    <p className="p48-rooms-foot">已关注 <strong>{followedCount}</strong> / 共 {totalCount} 位成员</p>
  </>;
}

// Account + check-in used to be two permanent cards above the workspace, which
// pushed the messages most of a screen down for settings that change rarely.
// They now live behind one header button.
function AccountSettings({ open, onClose, auth, profile, checkin, errors, busy, autoCheck, setAutoCheck, saveAutoCheck, targetAccount, setTargetAccount, switchAccount, onCheckin, onRefresh }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  const signed = checkin?.hasCheck === true || checkin?.hasCheck === 1 || checkin?.isCheckin === true || checkin?.isCheckin === 1 || checkin?.checked === true || checkin?.isCheckIn === true;
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <div className="modal-card p48-settings" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="p48-settings-title">
      <div className="modal-header">
        <div className="modal-title-wrap">
          <span className="modal-icon-badge primary"><IconSettings size={18} /></span>
          <h3 id="p48-settings-title">账号与签到设置</h3>
        </div>
        <button ref={closeRef} type="button" className="modal-close-btn" onClick={onClose} disabled={!!busy} aria-label="关闭"><IconX size={16} /></button>
      </div>
      <div className="modal-body p48-settings-body">
        <section className="p48-settings-block">
          <h4>当前账号</h4>
          <div className="p48-profile">
            <SafeImage src={profile?.avatar || ''} alt="账号头像" fallback={<span>48</span>} />
            <div>
              <strong>{profile?.nickname || (auth?.authenticated ? '已登录' : auth ? '尚未登录或凭据失效' : '正在验证…')}</strong>
              <p>{profile?.userId ? 'UID ' + profile.userId : '登录后可获取个人资料与房间消息'}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={onRefresh}>{busy === 'refresh' ? '刷新中…' : '刷新状态'}</button>
          </div>
          {profile?.level != null && <p className="p48-settings-line">等级：{typeof profile.level === 'object' ? profile.level.level || '—' : profile.level}</p>}
          {profile?.signature && <p className="p48-settings-line">{profile.signature}</p>}
          {errors.profile && <p role="alert" className="p48-error">{errors.profile}</p>}
          {!!profile?.accounts?.length && <div className="p48-settings-field">
            <label htmlFor="p48-linked-account">主号 / 小号</label>
            <div className="p48-actions">
              <select id="p48-linked-account" value={targetAccount} disabled={!!busy} onChange={e => setTargetAccount(e.target.value)} className="p48-select">
                {profile.accounts.map(item => <option key={item.userId} value={item.userId}>{item.nickname || item.userId} · {item.kind === 'main' ? '主号' : '小号'}{item.current ? '（当前）' : ''}</option>)}
              </select>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || targetAccount === str(profile.userId)} onClick={switchAccount}>{busy === 'switch' ? '切换中…' : '切换账号'}</button>
            </div>
            <small>切换后，签到和消息读取使用所选账号，原关注列表将清空；口袋48其他设备可能需要重新登录。</small>
          </div>}
          {errors.switch && <p role="alert" className="p48-error">{errors.switch}</p>}
        </section>

        <section className="p48-settings-block">
          <h4>每日签到</h4>
          <div className="p48-checkin-row">
            <span className={'p48-checkin-state' + (signed ? ' done' : '')}>
              {signed ? <><IconCheck size={14} aria-hidden="true" />今天已签到</> : checkin ? '今天尚未签到' : auth?.authenticated ? (errors.checkin ? '签到状态查询失败' : '正在查询签到状态…') : '登录后可查询今日签到情况'}
            </span>
            {checkin?.checkinDays != null && <small className="p48-settings-line">累计 {checkin.checkinDays} 天</small>}
            <button type="button" className="btn btn-primary btn-sm" disabled={!auth?.authenticated || !checkin || !!busy || signed} onClick={onCheckin}>{busy === 'checkin' ? '签到中…' : signed ? '今日已完成' : '立即签到'}</button>
          </div>
          {errors.checkin && <p role="alert" className="p48-error">{errors.checkin}</p>}
          <div className="p48-auto-form">
            <label><input type="checkbox" checked={autoCheck.enabled} onChange={e => setAutoCheck(old => ({ ...old, enabled: e.target.checked }))} /> 每天自动签到</label>
            <div className="p48-auto-times">
              <input aria-label="签到开始时间" type="time" value={autoCheck.start} onChange={e => setAutoCheck(old => ({ ...old, start: e.target.value }))} />
              <span>至</span>
              <input aria-label="签到结束时间" type="time" value={autoCheck.end} onChange={e => setAutoCheck(old => ({ ...old, end: e.target.value }))} />
            </div>
            <small>北京时间，每天在时段内随机执行一次；使用保存设置时的账号，异常自动暂停。</small>
            {autoCheck.nextAt && <small>下次：{time(autoCheck.nextAt)}</small>}
            {autoCheck.lastResult && <small>{autoCheck.lastResult}</small>}
            {errors.autoCheck && <p className="p48-error" role="alert">{errors.autoCheck}</p>}
          </div>
        </section>
      </div>
      <div className="modal-footer">
        <Link className="btn btn-secondary" to="/admin/auto-record?login=1">{auth?.authenticated ? '切换登录账号' : '登录口袋48'}</Link>
        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => saveAutoCheck()}>保存签到设置</button>
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={onClose}>完成</button>
      </div>
    </div>
  </div>;
}

export default function Pocket48Page() {
  const toast = useToast();
  const [auth, setAuth] = useState(null), [profile, setProfile] = useState(null), [checkin, setCheckin] = useState(null);
  const [roster, setRoster] = useState({ groups: [], followedCount: 0, goneCount: 0, openCount: 0, totalCount: 0 });
  const [rosterLoading, setRosterLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState(''), [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(''), [followBusy, setFollowBusy] = useState(''), [errors, setErrors] = useState({});
  // Left panel view: the full roster, only the members the account follows, or
  // only the rooms that are still readable / revoked. Remembered across visits
  // so a reader who works from one slice keeps landing on it.
  const [memberView, setMemberView] = useState(() => {
    try { const saved = localStorage.getItem(MEMBER_VIEW_KEY); return MEMBER_VIEWS.includes(saved) ? saved : 'all'; } catch { return 'all'; }
  });
  const changeMemberView = useCallback(view => {
    setMemberView(view);
    try { localStorage.setItem(MEMBER_VIEW_KEY, view); } catch { /* private mode: in-memory only */ }
  }, []);
  // Folded team headers, remembered like the view so a reader who keeps, say,
  // GNZ48 folded does not have to fold it again next visit.
  const [collapsed, setCollapsed] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); return new Set(Array.isArray(saved) ? saved : []); } catch { return new Set(); }
  });
  // toggleGroup(key) flips one team; toggleGroup(keys[]) is the bulk form and
  // toggleGroup(null) unfolds everything.
  const toggleGroup = useCallback(keys => {
    if (Array.isArray(keys)) {
      setCollapsed(old => {
        const next = new Set(old);
        keys.forEach(k => next.add(k));
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
        return next;
      });
      return;
    }
    setCollapsed(old => {
      const next = new Set(old);
      if (keys === null) next.clear();
      else if (next.has(keys)) next.delete(keys); else next.add(keys);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Last message-read exchange, kept so the empty state can explain itself.
  const [streamTrace, setStreamTrace] = useState(null);
  const [autoCheck, setAutoCheck] = useState({ enabled: false, start: '09:00', end: '11:00' });
  const [targetAccount, setTargetAccount] = useState('');
  const requestId = useRef(0);
  const get = async path => payload(await adminApi.get(path));
  const failure = (key, e) => setErrors(old => ({ ...old, [key]: errorMessage(e) }));
  async function loadRoster() {
    setRosterLoading(true); setErrors(old => ({ ...old, roster: '' }));
    try { setRoster(await get('/pocket48/friendships/roster')); }
    catch (e) { failure('roster', e); }
    finally { setRosterLoading(false); }
  }
  async function refresh() {
    setBusy('refresh'); setProfile(null); setCheckin(null); setErrors({});
    try {
      const status = await get('/pocket48/auth/status'); setAuth(status);
      await get(base + '/auto-checkin').then(setAutoCheck).catch(e => failure('autoCheck', e));
      if (status.authenticated) await Promise.all([
        get(base + '/profile').then(data => { setProfile(data); setTargetAccount(str(data.userId)); }).catch(e => failure('profile', e)),
        get(base + '/checkin').then(setCheckin).catch(e => failure('checkin', e)),
        loadRoster(),
      ]);
      else { setRoster({ groups: [], followedCount: 0, goneCount: 0, openCount: 0, totalCount: 0 }); setSelected(null); }
    } catch (e) { failure('profile', e); } finally { setBusy(''); }
  }
  useEffect(() => { refresh(); return () => { requestId.current++; }; }, []);
  async function doCheckin() {
    setBusy('checkin'); setErrors(old => ({ ...old, checkin: '' }));
    try {
      payload(await adminApi.post(base + '/checkin', undefined));
      toast.success('签到成功');
      setCheckin(await get(base + '/checkin'));
    } catch (e) { failure('checkin', e); } finally { setBusy(''); }
  }
  async function switchAccount() {
    if (busy || !targetAccount || targetAccount === str(profile?.userId)) return;
    setBusy('switch'); setErrors(old => ({ ...old, switch: '' }));
    try {
      await adminApi.post(base + '/switch', { userId: targetAccount });
      requestId.current++; setSelected(null);
      setRoster({ groups: [], followedCount: 0, goneCount: 0, openCount: 0, totalCount: 0 });
      toast.success('已切换账号');
      await refresh();
    } catch (e) { failure('switch', e); } finally { setBusy(''); }
  }
  async function saveAutoCheck() {
    setBusy('autoCheck'); setErrors(old => ({ ...old, autoCheck: '' }));
    try { setAutoCheck(payload(await adminApi.put(base + '/auto-checkin', { enabled: autoCheck.enabled, start: autoCheck.start, end: autoCheck.end }))); toast.success('自动签到设置已保存'); }
    catch (e) { failure('autoCheck', e); } finally { setBusy(''); }
  }
  // Follow/unfollow writes to the Pocket48 account itself. The list is re-derived
  // from the server's own follow set afterwards so the star reflects the account,
  // not a local guess.
  async function toggleFollow(member) {
    if (followBusy) return;
    const on = member.followed;
    setFollowBusy(member.ownerId); setErrors(old => ({ ...old, follow: '' }));
    try {
      if (on) await adminApi.delete('/pocket48/friendships/followed/' + encodeURIComponent(member.ownerId));
      else await adminApi.post('/pocket48/friendships/followed', { ownerId: member.ownerId });
      setRoster(old => ({
        ...old,
        followedCount: Math.max(0, old.followedCount + (on ? -1 : 1)),
        groups: old.groups.map(g => ({ ...g, members: g.members.map(x => x.ownerId === member.ownerId ? { ...x, followed: !on } : x) })),
      }));
      toast.success(on ? '已取消关注 ' + shortName(member.ownerName) : '已关注 ' + shortName(member.ownerName));
      loadRoster();
    } catch (e) { failure('follow', e); }
    finally { setFollowBusy(''); }
  }
  const openRoom = useCallback(member => {
    setSelected({ roomId: member.roomId, ownerId: member.ownerId, ownerName: member.ownerName, teamName: member.teamName });
  }, []);
  const currentScope = scopes.find(s => s.id === scope) || scopes[0];

  return <div className="p48-page">
    <div className="page-header admin-page-header">
      <div><h1>口袋48</h1></div>
      <div className="p48-header-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setSettingsOpen(true)}><IconSettings size={15} aria-hidden="true" />账号与签到{roster.followedCount ? <span className="p48-header-badge">{roster.followedCount}</span> : null}</button>
      </div>
    </div>

    <section className="card p48-workspace">
      <aside className="p48-rooms">
        <div className="p48-rooms-head">
          <h2>成员关注</h2>
          <span className="p48-count">{roster.totalCount || ''}</span>
          <button type="button" className="p48-rooms-refresh" disabled={rosterLoading} onClick={loadRoster} aria-label="刷新成员名单">
            <IconRefresh size={13} aria-hidden="true" />
          </button>
        </div>
        <p className="p48-rooms-hint">关注变更会同步到口袋48账号。</p>
        <MemberList groups={roster.groups} query={query} onQuery={setQuery} onPick={openRoom} onToggle={toggleFollow}
          busyId={followBusy} followedCount={roster.followedCount} goneCount={roster.goneCount} openCount={roster.openCount} totalCount={roster.totalCount}
          loading={rosterLoading} error={errors.roster} view={memberView} onView={changeMemberView} selectedId={selected?.ownerId}
          collapsed={collapsed} onToggleGroup={toggleGroup}
          onMissingRoom={m => toast.error(shortName(m.ownerName) + ' 暂时没有房间号，无法读取消息；可点右上角刷新成员名单重试')} />
      </aside>

      <div className="p48-conversation">
        <div className="p48-toolbar p48-toolbar-top">
          <div className="p48-current">
            <h2>{selected ? roomLabel(selected) : '选择一个成员开始阅读'}</h2>
            {selected && <span className="p48-current-id">{selected.roomId}</span>}
          </div>
        </div>

        <div className="p48-toolbar p48-toolbar-scope">
          <div className="p48-scope" role="group" aria-label="消息筛选">
            {scopes.map(s => <button key={s.id} type="button" className={scope === s.id ? 'on' : ''} aria-pressed={scope === s.id} onClick={() => setScope(s.id)}>
              {s.id === 'members' ? <IconUsers size={14} aria-hidden="true" /> : <IconMessageSquare size={14} aria-hidden="true" />}
              {s.title}
            </button>)}
          </div>
          <small className="p48-scope-hint">{currentScope.hint} · 最新消息在上方</small>
        </div>

        {errors.follow && <p role="alert" className="p48-error">{errors.follow}</p>}
        <MessageStream key={str(selected?.roomId) + ':' + scope} room={selected} scope={scope} onTrace={setStreamTrace} />
        {selected && <Diagnose room={selected} trace={streamTrace} />}
      </div>
    </section>


    <AccountSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} auth={auth} profile={profile} checkin={checkin} errors={errors}
      busy={busy} autoCheck={autoCheck} setAutoCheck={setAutoCheck} saveAutoCheck={saveAutoCheck}
      targetAccount={targetAccount} setTargetAccount={setTargetAccount} switchAccount={switchAccount}
      onCheckin={doCheckin} onRefresh={refresh} />
  </div>;
}
