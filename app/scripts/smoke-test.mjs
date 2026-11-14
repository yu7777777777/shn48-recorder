// 48tools 1.32.4 smoke-test contract.
const baseUrl = (process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const username = process.env.SMOKE_ADMIN_USERNAME || process.env.ADMIN_USERNAME;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 10000);

let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${pathname}`, {
      redirect: "manual",
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") || "";
  assert(contentType.includes("application/json"), `${label}: expected JSON, got ${contentType || "no content type"}`);
  return response.json();
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log(`Smoke testing ${baseUrl}`);

await check("public health is reachable", async () => {
  const response = await request("/api/public/health");
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const health = await readJson(response, "health");
  assert(health?.data?.version === "1.31.0", `expected version 1.31.0, got ${health?.data?.version || "missing"}`);
});

await check("public live list is reachable", async () => {
  const response = await request("/api/public/live");
  assert(response.status === 200, `expected 200, got ${response.status}`);
  await readJson(response, "live list");
});

await check("admin API rejects anonymous access", async () => {
  const response = await request("/api/admin/pocket48/recordings/active");
  assert(response.status === 401, `expected 401, got ${response.status}`);
});

await check("legacy arbitrary-URL proxy is unavailable", async () => {
  const response = await request("/api/stream/proxy?url=http%3A%2F%2F127.0.0.1%3A9%2Fprivate");
  assert([404, 410].includes(response.status), `expected 404 or 410, got ${response.status}`);
});

if (!username || !password) {
  console.error(
    "FAIL admin login flow: set SMOKE_ADMIN_USERNAME and SMOKE_ADMIN_PASSWORD to the same test credentials used by the server",
  );
  process.exitCode = 1;
} else {
  let cookie = "";

  await check("admin login creates an authenticated session", async () => {
    const response = await request("/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    cookie = (response.headers.get("set-cookie") || "").split(";", 1)[0];
    assert(cookie.includes("="), "login did not return a session cookie");

    const sessionResponse = await request("/api/admin/auth/session", {
      headers: { cookie },
    });
    assert(sessionResponse.status === 200, `session expected 200, got ${sessionResponse.status}`);
    const session = await readJson(sessionResponse, "session");
    assert(session.authenticated === true, "session is not authenticated");
  });

  await check("authenticated admin can reach a protected endpoint", async () => {
    assert(cookie, "login did not complete");
    const response = await request("/api/admin/pocket48/recordings/active", {
      headers: { cookie },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    await readJson(response, "active recordings");
  });

  await check("admin logout succeeds", async () => {
    assert(cookie, "login did not complete");
    const response = await request("/api/admin/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
  });
}

console.log(`${passed} smoke checks passed${process.exitCode ? "; one or more checks failed" : ""}.`);
