const base = "http://127.0.0.1:3000";
const checks = [
  ["health", "/api/public/health"],
  ["root-html", "/"],
  ["admin-config-unauth", "/api/admin/config"],
  ["public-live", "/api/public/live"],
  ["replays-page", "/replays"],
];
(async () => {
  for (const [name, path] of checks) {
    try {
      const response = await fetch(base + path);
      const text = await response.text();
      const head = text.slice(0, 130).replace(/\s+/g, " ");
      console.log(`${name}: status=${response.status} bytes=${text.length} ${head}`);
    } catch (error) {
      console.log(`${name}: ERROR ${error.message}`);
    }
  }
  // The live endpoint must no longer disguise upstream failure as an empty list.
  const live = await (await fetch(base + "/api/public/live")).json().catch(() => null);
  console.log("live-success-field:", live?.success, "list-length:", Array.isArray(live?.data?.liveList) ? live.data.liveList.length : "n/a");
})();
