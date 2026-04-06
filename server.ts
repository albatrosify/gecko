import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { connectDb } from "./server/db.ts";
import { createAuthRouter } from "./server/auth.ts";
import { log, LOG_PATH } from "./server/logger.ts";
import { getClientInfo } from "./server/utils.ts";
import { initCronManager } from "./server/sync.ts";
import { initProxyStatsInterval } from "./server/proxy-stats.ts";
import { DEFAULT_PORT } from "./server/config.ts";

// Routers
import { createSystemRouter } from "./server/routes/system.ts";
import { createAdminRouter } from "./server/routes/admin.ts";
import { createSourcesRouter } from "./server/routes/sources.ts";
import { createEpgsRouter } from "./server/routes/epgs.ts";
import { createPlaylistsRouter } from "./server/routes/playlists.ts";
import { createMappingsRouter } from "./server/routes/mappings.ts";
import { createMigrationsRouter } from "./server/routes/migrations.ts";
import { createCustomCategoriesRouter } from "./server/routes/customCategories.ts";
import { createQualityScanRouter } from "./server/routes/quality-scan.ts";
import { createProxyRouter } from "./server/routes/proxy.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure log file exists on start
function initLogFile() {
  const dir = path.dirname(LOG_PATH);
  console.log("Initializing log file at:", LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, `[${new Date().toLocaleTimeString()}] System Started\n`);
  console.log("Log file ready.");
}
initLogFile();

async function startServer() {
  log("Starting server...");
  try {
    // Environment validation
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable is not set. The server cannot start without a secret for security reasons. Please check your .env file or Docker environment configuration.');
    }

    // Connect to MongoDB
    await connectDb();
    log("Connected to MongoDB");

    // Initialize cron jobs
    await initCronManager().catch(err => log(`[Cron] Initialization failed: ${err.message}`));

    // Initialize proxy stats interval
    initProxyStatsInterval();

    const app = express();
    const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT));

    app.use(express.json({ limit: '50mb' }));
    // Disable ETag-based caching for all API responses so clients always get
    // fresh data after mutations (prevents 304 returning stale mapping orders)
    app.set('etag', false);
    app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    // Request logging middleware - registered first so all routes are logged
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        // Skip logging the logs endpoint itself to avoid feedback loop
        if (req.path !== '/api/system/logs') {
          const duration = Date.now() - start;
          log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms - ${getClientInfo(req)}`);
        }
      });
      next();
    });

    // Health check — used by Docker healthcheck and monitoring
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Register Routers
    const epgsRouter = createEpgsRouter();
    app.use('/api/auth', createAuthRouter());
    app.use('/api', createSystemRouter());
    app.use('/api', createAdminRouter());
    app.use('/api', createSourcesRouter());
    app.use('/api', epgsRouter);
    app.use('/api', createPlaylistsRouter(epgsRouter));
    app.use('/api', createMappingsRouter());
    app.use('/api', createMigrationsRouter());
app.use('/api', createCustomCategoriesRouter());
    app.use('/api', createQualityScanRouter());

    // Proxy routes (some are public, some are authenticated by playlist credentials)
    app.use('/', createProxyRouter());

    // Frontend serving
    const distPath = path.join(process.cwd(), "dist");
    const serveSpaFallback = () => {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        // Never serve HTML for API routes — return 404 JSON instead
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.sendFile(path.join(distPath, "index.html"));
      });
    };

    if (process.env.NODE_ENV !== "production") {
      try {
        const vite = await createViteServer({
          server: { middlewareMode: true },
          appType: "spa",
        });
        app.use(vite.middlewares);
        log("Vite dev server started");
      } catch (e) {
        log("Failed to start Vite dev server: " + (e instanceof Error ? e.message : String(e)));
        // Fall back to serving the built dist/ if available
        if (fs.existsSync(distPath)) {
          serveSpaFallback();
          log("Falling back to serving from dist/");
        } else {
          log("WARNING: No dist/ folder found and Vite failed — frontend will not be served");
        }
      }
    } else {
      serveSpaFallback();
    }

    const server = app.listen(PORT, "0.0.0.0", () => {
      log(`Server running on http://0.0.0.0:${PORT}`);
    });

    server.on('error', (err) => {
      log("Server listen error: " + err.message);
    });

  } catch (error) {
    log("Failed to start server: " + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  log('Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at: ' + promise + ' reason: ' + reason);
});

startServer();
