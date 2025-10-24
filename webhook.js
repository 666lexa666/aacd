import express from "express";

const router = express.Router();

// 📌 Webhook endpoint
router.post("/", (req, res) => {
  const timestamp = new Date().toISOString();
  const body = req.body;

  console.log(`[${timestamp}] Webhook received:`, JSON.stringify(body, null, 2));

  // ✅ Отправляем стандартный ответ
  res.status(200).json({ result: "ok" });
});

export default router;
