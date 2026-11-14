export function chooseHlsPlaybackEngine({ hlsJsSupported, nativeHlsSupported }) {
  if (hlsJsSupported) return "hls.js";
  if (nativeHlsSupported) return "native";
  return null;
}

export function safeHlsErrorFacts(data = {}) {
  const networkDetails = data.networkDetails;
  let contentType = null;
  try {
    contentType = networkDetails?.getResponseHeader?.("content-type") || null;
  } catch {
    contentType = null;
  }
  return {
    fatal: Boolean(data.fatal),
    type: data.type || "unknown",
    details: data.details || "unknown",
    status: data.response?.code ?? networkDetails?.status ?? null,
    contentType,
  };
}
