import { app } from "./app.js";
import { db } from "./db.js";
import { logger } from "./logger.js";

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, `WE ARE LIVE AT ${PORT}`)
})

// graceful shutdown: Fly sends SIGTERM on deploy/stop → finish in-flight requests, close DB cleanly
function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
