import "dotenv/config";
import path from "path";
import express from "express";
import config from "./config";
import pdfRouter from "./routes/pdf";

const app = express();

// Serve PDF editor UI from public/
app.use(express.static(path.join(__dirname, "..", "public")));

// Increase JSON limit for base64 PNG payloads from the editor (up to ~100 MB)
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// PDF editor routes
app.use("/api/pdf", pdfRouter);

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health           — Health check`);
  console.log(`  GET  /                 — PDF Editor UI`);
  console.log(`  POST /api/pdf/upload   — Upload PDF for editing`);
  console.log(`  POST /api/pdf/export   — Download edited PDF`);
});
