import { Router, Request, Response } from "express";
import multer, { FileFilterCallback } from "multer";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import os from "os";

const router = Router();

// ── Upload storage ─────────────────────────────────────────────────────────
const uploadDir = path.join(os.tmpdir(), "pdf-editor-sessions");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.pdf`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  },
});

// ── In-memory session map (sufficient for a single-process POC) ─────────────
interface Session {
  filePath: string;
  pageCount: number;
  originalName: string;
}
const sessions = new Map<string, Session>();

// ── POST /api/pdf/upload ────────────────────────────────────────────────────
router.post(
  "/upload",
  upload.single("pdf"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No PDF file provided" });
      return;
    }

    try {
      const fileBuffer = fs.readFileSync(req.file.path);
      const pdfDoc = await PDFDocument.load(fileBuffer, {
        ignoreEncryption: true,
      });
      const pageCount = pdfDoc.getPageCount();

      const sessionId = uuidv4();
      sessions.set(sessionId, {
        filePath: req.file.path,
        pageCount,
        originalName: req.file.originalname,
      });

      res.json({ sessionId, pageCount, fileName: req.file.originalname });
    } catch {
      // Clean up partial upload on failure
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(422).json({ error: "Invalid or corrupted PDF file" });
    }
  }
);

// ── GET /api/pdf/file/:sessionId ───────────────────────────────────────────
router.get("/file/:sessionId", (req: Request, res: Response): void => {
  const session = sessions.get((req.params["sessionId"] as string) ?? "");
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.resolve(session.filePath));
});

// ── POST /api/pdf/export ───────────────────────────────────────────────────
// Body: { sessionId: string, pages: { [pageNum: string]: "data:image/png;base64,..." } }
// Returns the original PDF with each modified page having the annotation PNG
// overlaid at full-page size. Because we overlay PNG, ALL fonts/styles work
// regardless of PDF type — edits are pixel-accurate.
router.post("/export", async (req: Request, res: Response): Promise<void> => {
  const { sessionId, pages } = req.body as {
    sessionId: string;
    pages: Record<string, string>;
  };

  if (!sessionId || typeof pages !== "object") {
    res.status(400).json({ error: "sessionId and pages are required" });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  if (Object.keys(pages).length === 0) {
    res.status(400).json({ error: "No annotated pages provided" });
    return;
  }

  try {
    const pdfBytes = fs.readFileSync(session.filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
    });
    const totalPages = pdfDoc.getPageCount();

    for (const [pageNumStr, dataUrl] of Object.entries(pages)) {
      const pageIndex = parseInt(pageNumStr, 10) - 1;
      if (pageIndex < 0 || pageIndex >= totalPages) continue;

      // Validate data URL format
      if (!dataUrl.startsWith("data:image/png;base64,")) {
        continue;
      }

      const base64Data = dataUrl.slice("data:image/png;base64,".length);
      const pngBytes = Buffer.from(base64Data, "base64");

      const pngImage = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.getPage(pageIndex);
      const { width, height } = page.getSize();

      // Overlay annotation layer at full page size (covers x: 0, y: 0 bottom-left).
      // pdf-lib coordinate origin is bottom-left, y up. Drawing at y=0 with full
      // height fills the page correctly.
      page.drawImage(pngImage, { x: 0, y: 0, width, height });
    }

    const modifiedBytes = await pdfDoc.save();
    const outName = session.originalName.replace(/\.pdf$/i, "-edited.pdf");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(outName)}"`
    );
    res.send(Buffer.from(modifiedBytes));
  } catch (err) {
    res.status(500).json({
      error: "Failed to generate PDF",
      detail: String(err),
    });
  }
});

export default router;
