import express from "express"
import { showsRouter } from './routes/shows.js'
import { authRouter } from './routes/auth.js';
import { reservationsRouter } from './routes/reservations.js';
import { register, httpDuration } from './metrics.js';


export const app = express()

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
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
})