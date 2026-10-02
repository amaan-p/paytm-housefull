import express from "express"

export const app = express()

//so that big seat list can fit 
app.use(express.json({ limit: '1mb' }));


app.get("/health/live",(req,res)=>{
    res.json({status:"OK"})
})

//takes care of unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'endpoint_not_found' });
});

// basic error handling 
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body_too_large' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});