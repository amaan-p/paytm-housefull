import express from "express"
import { showsRouter } from './routes/shows.js'
import { authRouter } from './routes/auth.js';
import { reservationsRouter } from './routes/reservations.js';
import { register, httpDuration } from './metrics.js';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { db } from './db.js';


export const app = express()

// request id: reuse the caller's X-Request-Id if sane, else make one; echo it back
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

app.use(pinoHttp({
  logger,
  quietReqLogger: true, // req.log lines carry just reqId, not the whole request
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = REQUEST_ID_PATTERN.test(incoming ?? '') ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  // 4xx are normal declines (info), only 5xx are errors
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
  // don't flood logs with scrapes / health checks
  autoLogging: { ignore: (req) => req.url === '/metrics' || req.url.startsWith('/health') },
}));

//so that big seat list can fit
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
});

app.get("/health/live",(req,res)=>{
    res.json({status:"OK"})
})

// readiness: actually touch the DB; fail closed (503) if it can't be queried
app.get('/health/ready', (req, res) => {
  try {
    db.prepare('SELECT 1 FROM shows LIMIT 1').get();
    res.json({ status: 'ready' });
  } catch (err) {
    req.log.error({ err }, 'readiness check failed');
    res.status(503).json({ status: 'unavailable', reason: 'db_unreachable' });
  }
})

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});


//ROUTESS
app.use('/shows', showsRouter)
app.use('/auth', authRouter);
app.use('/reservations', reservationsRouter);

//takes care of unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'endpoint_not_found' });
})

// basic error handling 
app.use((err, req, res, next) => {
  if (err.isDomain) {
    return res.status(err.status).json({ error: err.code });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body_too_large' });
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_error', request_id: req.id });
})