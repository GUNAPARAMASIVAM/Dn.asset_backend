let app;
try {
  app = require('../src/server').default || require('../src/server');
} catch (err: any) {
  console.error("Vercel Startup Crash:", err);
  app = (req: any, res: any) => {
    res.status(500).json({ error: "Startup Crash", message: err.message, stack: err.stack });
  };
}
export default app;
