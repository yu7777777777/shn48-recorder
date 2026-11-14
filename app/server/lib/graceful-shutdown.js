"use strict";

function createGracefulShutdown(options) {
  const {
    server,
    stopRecorders,
    closeEvents,
    saveState,
    forceClose = () => server.closeAllConnections?.(),
    exit = (code) => process.exit(code),
    logger = console,
    timeoutMs = 20_000,
  } = options;
  let inFlight = null;

  function shutdown(signal = "shutdown") {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      logger.log(`[server] ${signal} received; starting graceful shutdown`);
      let closeError = null;
      const serverClosed = new Promise((resolve) => {
        try {
          server.close((err) => {
            if (err) closeError = err;
            resolve();
          });
          server.closeIdleConnections?.();
        } catch (err) {
          closeError = err;
          resolve();
        }
      });

      try { closeEvents(); } catch (err) { logger.error("[server] SSE shutdown error:", err); }

      let workError = null;
      const work = Promise.all([
        serverClosed,
        Promise.resolve().then(stopRecorders),
      ]).catch((err) => { workError = err; });

      let timeoutId;
      const deadline = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const outcome = await Promise.race([work.then(() => "complete"), deadline]);
      clearTimeout(timeoutId);

      if (outcome === "timeout") {
        logger.error(`[server] graceful shutdown exceeded ${timeoutMs}ms; forcing connections closed`);
        try { forceClose(); } catch (err) { logger.error("[server] forced connection close error:", err); }
      }

      try { saveState(); } catch (err) {
        workError = workError || err;
        logger.error("[server] final state save error:", err);
      }

      const exitCode = outcome === "complete" && !closeError && !workError ? 0 : 1;
      if (closeError) logger.error("[server] HTTP server close error:", closeError);
      if (workError) logger.error("[server] recorder shutdown error:", workError);
      logger.log(`[server] shutdown complete (exit ${exitCode})`);
      exit(exitCode);
      return { outcome, exitCode };
    })();
    return inFlight;
  }

  return {
    shutdown,
    isShuttingDown: () => Boolean(inFlight),
  };
}

module.exports = { createGracefulShutdown };
