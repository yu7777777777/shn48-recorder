"use strict";

const net = require("net");
const tls = require("tls");
const { randomUUID } = require("crypto");

function normalizeHost(value) {
  const host = String(value || "").trim();
  if (!host || host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error("SMTP 服务器地址无效");
  return host;
}
function encodeHeader(value) {
  const text = String(value || "").replace(/[\r\n]/g, " ");
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
}
function address(value) {
  const text = String(value || "").trim();
  if (!/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/.test(text)) throw new Error("邮件地址无效");
  return text;
}
function message({ from, to, subject, text }) {
  const body = String(text || "").replace(/\r\n|\r/g, "\n").split("\n").map(line => line.startsWith(".") ? `.${line}` : line).join("\r\n");
  return [`From: ${address(from)}`, `To: ${address(to)}`, `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@shn48.local>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
}

async function send(config, payload) {
  const host = normalizeHost(config.host);
  const port = Number(config.port || 465);
  const secure = config.secure === undefined ? port === 465 : Boolean(config.secure);
  let socket;
  let buffer = "", responseLines = [], responses = [], waiter;
  const fail = () => { if (waiter) { const pending = waiter; waiter = null; pending.reject(new Error("SMTP 连接失败或超时")); } };
  const data = chunk => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) { fail(); socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
      responseLines.push(line);
      if (/^\d{3} /.test(line)) {
        const response = { code: Number(line.slice(0, 3)), text: responseLines.join("\n") }; responseLines = [];
        if (waiter) { const pending = waiter; waiter = null; pending.resolve(response); } else responses.push(response);
      }
    }
  };
  function attach() { socket.on("data", data); socket.on("error", fail); socket.on("close", fail); socket.setTimeout(15000, () => { fail(); socket.destroy(); }); }
  function read() {
    if (responses.length) return Promise.resolve(responses.shift());
    if (socket.destroyed) return Promise.reject(new Error("SMTP 连接已关闭"));
    return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  }
  async function expect(codes) {
    const response = await read();
    if (!codes.includes(response.code)) throw new Error(`SMTP 服务器拒绝请求（${response.code}）`);
    return response.text;
  }
  async function command(value, codes) {
    if (/[\r\n]/.test(value)) throw new Error("SMTP 参数不能包含换行");
    socket.write(value + "\r\n");
    return expect(codes);
  }
  const deadline = setTimeout(() => { fail(); socket?.destroy(); }, 60000);
  try {
    socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true }) : net.connect({ host, port });
    attach();
    await expect([220]);
    let capabilities = await command("EHLO shn48.local", [250]);
    if (!secure && /STARTTLS/i.test(capabilities)) {
      await command("STARTTLS", [220]);
      socket.removeListener("data", data); socket.removeListener("error", fail); socket.removeListener("close", fail); socket.setTimeout(0);
      socket = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true });
      attach();
      await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
      capabilities = await command("EHLO shn48.local", [250]);
    }
    if (config.user) {
      if (!socket.encrypted) throw new Error("SMTP 服务器未提供 TLS，不能发送登录凭据");
      if (/AUTH[^\n]*\bPLAIN\b/i.test(capabilities)) {
        await command("AUTH PLAIN " + Buffer.from(`\0${config.user}\0${config.pass || ""}`).toString("base64"), [235]);
      } else {
        await command("AUTH LOGIN", [334]);
        await command(Buffer.from(String(config.user)).toString("base64"), [334]);
        await command(Buffer.from(String(config.pass || "")).toString("base64"), [235]);
      }
    }
    const from = address(config.from || config.user), to = address(config.to);
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command("DATA", [354]);
    socket.write(message({ from, to, subject: payload.title, text: payload.text }) + "\r\n.\r\n");
    await expect([250]);
    socket.end("QUIT\r\n");
  } finally { clearTimeout(deadline); socket?.destroy(); }
}
module.exports = { send, _internals: { normalizeHost, encodeHeader, message, address } };
