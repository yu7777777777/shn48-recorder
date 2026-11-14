"use strict";

// SSE helper: broadcast events to all connected clients
const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch {}
  }
}

function getClientCount() {
  return clients.size;
}

function closeAll() {
  for (const client of clients) {
    try { client.end(); } catch {}
  }
  clients.clear();
}

module.exports = { addClient, broadcast, getClientCount, closeAll };
