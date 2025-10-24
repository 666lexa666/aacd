import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// Папка для логов
const logFile = path.join(process.cwd(), "webhook_logs.txt");

// 📌 Webhook endpoint
app.post("/api/sub/webhook/payment", (req, res) => {
  const timestamp = new Date().toISOString();
  const body = req.body;

  console.log(`[${timestamp}] Webhook received:`, body);

  // Сохраняем лог в файл
  fs.appendFile(logFile, `[${timestamp}] ${JSON.stringify(body)}\n`, (err) => {
    if (err) console.error("❌ Failed to write log:", err);
  });

  // Ответ серверу, что получили уведомление
  res.status(200).json({ result: "ok" });
});

// 🔹 HTTP-сервер на порту 10000
const PORT = process.env.SUB_PORT || 10000;
app.listen(PORT, () => {
  console.log(`Webhook HTTP server running on http://localhost:${PORT}`);
});
