"use strict";

const pocket48 = require("./api");

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_IDLE_MS = 30_000;
const MAX_SEEN_MESSAGES = 1_000;

function clean(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseCustom(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string" || value.length > 16_384) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeMessage(message = {}) {
  if (!message || typeof message !== "object") return null;
  const custom = [message.custom, message.content, message.msg_setting_?.ext_]
    .map(parseCustom).find(Boolean) || {};
  const extInfo = parseCustom(message.extInfo) || {};
  const messageType = clean(custom.messageType || custom.msgType || message.messageType, 48).toUpperCase();
  const upstreamType = clean(message.msgType || message.type, 48).toUpperCase();
  const isBarrage = messageType === "BARRAGE_NORMAL" || messageType === "BARRAGE_MEMBER";
  const isPlainText = upstreamType === "TEXT" || Number(message.msg_type_) === 0;
  if (!isBarrage && !isPlainText) return null;

  const text = clean(custom.text || message.text || message.bodys, 100);
  if (!text) return null;
  const nickname = clean(
    custom.user?.nickName || custom.user?.nickname ||
    extInfo.user?.nickName || extInfo.user?.nickname ||
    message.senderName || message.fromNick || message.from_nick_ || "观众",
    24
  ) || "观众";
  const sourceId = clean(
    message.idClient || message.idServer || message.uuid ||
    message.client_msg_id_ || message.server_msg_id_ ||
    message.msgIdClient || message.msgIdServer || message.msgId,
    80
  );
  return {
    id: sourceId || `${Number(message.msgTime || message.timetag_ || message.time || Date.now())}:${nickname}:${text}`,
    nickname,
    text,
    member: messageType === "BARRAGE_MEMBER",
  };
}

function messageTime(message) {
  const value = Number(message?.msgTime || message?.timetag_ || message?.time || 0);
  return Number.isFinite(value) ? value : 0;
}

class DanmakuManager {
  constructor({
    api = pocket48,
    pollMs = DEFAULT_POLL_MS,
    idleMs = DEFAULT_IDLE_MS,
    maxRooms = 10,
    maxSubscribers = 100,
    logger = console,
  } = {}) {
    this.api = api;
    this.pollMs = Math.max(250, Number(pollMs) || DEFAULT_POLL_MS);
    this.idleMs = Math.max(1, Number(idleMs) || DEFAULT_IDLE_MS);
    this.maxRooms = Math.max(1, Number(maxRooms) || 10);
    this.maxSubscribers = Math.max(1, Number(maxSubscribers) || 100);
    this.logger = logger;
    this.rooms = new Map();
  }

  subscribe(value, listener) {
    const roomId = String(value || "");
    if (!/^\d{1,32}$/.test(roomId) || typeof listener !== "function") {
      const error = new Error("Invalid danmaku subscription");
      error.statusCode = 400;
      throw error;
    }
    if (this.getStats().subscribers >= this.maxSubscribers) {
      const error = new Error("Too many danmaku subscribers");
      error.statusCode = 503;
      throw error;
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.maxRooms) {
        const error = new Error("Too many danmaku rooms");
        error.statusCode = 503;
        throw error;
      }
      room = {
        roomId,
        listeners: new Set(),
        status: "connecting",
        pollTimer: null,
        idleTimer: null,
        polling: false,
        failures: 0,
        seen: new Set(),
        closed: false,
      };
      this.rooms.set(roomId, room);
      void this.poll(room);
    } else if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = null;
    }

    room.listeners.add(listener);
    this.emit(listener, "status", { status: room.status });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      room.listeners.delete(listener);
      if (!room.listeners.size && !room.idleTimer && !room.closed) {
        room.idleTimer = setTimeout(() => this.closeRoom(roomId), this.idleMs);
        room.idleTimer.unref?.();
      }
    };
  }

  async poll(room) {
    if (room.closed || room.polling || this.rooms.get(room.roomId) !== room) return;
    room.polling = true;
    try {
      const getMessages = this.api.getLiveDanmakuMessages || this.api.getAllRoomMessages;
      if (typeof getMessages !== "function") throw new Error("Pocket48 danmaku API unavailable");
      const result = await getMessages.call(this.api, room.roomId);
      const payload = result?.data;
      const messages = payload?.content?.message;
      if (!result || result.status < 200 || result.status >= 300 ||
          (payload?.status !== undefined && Number(payload.status) !== 200) || !Array.isArray(messages)) {
        throw new Error("Pocket48 danmaku request failed");
      }
      room.failures = 0;
      if (room.status !== "connected") {
        room.status = "connected";
        this.broadcast(room, "status", { status: "connected" });
      }
      for (const message of [...messages].sort((a, b) => messageTime(a) - messageTime(b))) {
        const normalized = normalizeMessage(message);
        if (!normalized || room.seen.has(normalized.id)) continue;
        room.seen.add(normalized.id);
        if (room.seen.size > MAX_SEEN_MESSAGES) room.seen.delete(room.seen.values().next().value);
        this.broadcast(room, "danmaku", normalized);
      }
    } catch (error) {
      room.failures += 1;
      if (room.failures >= 3 && room.status !== "error") {
        room.status = "error";
        this.broadcast(room, "status", { status: "error" });
        this.logger.warn?.("Pocket48 danmaku polling unavailable", {
          roomId: room.roomId,
          name: clean(error?.name || "Error", 40),
          code: clean(error?.code || "", 40),
        });
      }
    } finally {
      room.polling = false;
      if (!room.closed && this.rooms.get(room.roomId) === room) {
        room.pollTimer = setTimeout(() => void this.poll(room), this.pollMs);
        room.pollTimer.unref?.();
      }
    }
  }

  emit(listener, event, data) {
    try { listener(event, data); } catch {}
  }

  broadcast(room, event, data) {
    for (const listener of room.listeners) this.emit(listener, event, data);
  }

  closeRoom(roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room) return;
    room.closed = true;
    if (room.pollTimer) clearTimeout(room.pollTimer);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.listeners.clear();
    room.seen.clear();
    this.rooms.delete(room.roomId);
  }

  closeAll() {
    for (const roomId of [...this.rooms.keys()]) this.closeRoom(roomId);
  }

  getStats() {
    let subscribers = 0;
    for (const room of this.rooms.values()) subscribers += room.listeners.size;
    return { rooms: this.rooms.size, subscribers };
  }
}

const danmakuManager = new DanmakuManager();

module.exports = { DanmakuManager, danmakuManager, normalizeMessage };
