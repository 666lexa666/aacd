import express from "express";
import https from "https";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

// 🔹 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔹 Конфиг банка
const BANK_URL = "https://zkc2b-socium.koronacard.ru/refund/order";
const BANK_MEMBER_ID = "100000000223"; // Статический

// POST /api/refund
router.post("/", async (req, res) => {
  const { qr_id } = req.body;
  if (!qr_id) return res.status(400).json({ error: "qr_id required" });

  // 🔹 Находим платеж в Supabase
  const { data: payments, error } = await supabase
    .from("purchases")
    .select("*")
    .eq("qr_id", qr_id)
    .limit(1)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!payments) return res.status(404).json({ error: "Payment not found" });

  const payment = payments;

  // 🔹 Формируем payload для банка
  const payload = {
    internalTxId: `refund_${Date.now()}`,
    refId: `refund_${Date.now()}`,
    refType: "qrcId",
    refData: payment.qr_id,
    amount: Math.round(parseFloat(payment.amount) * 100), // рубли → копейки
    remitInfo: payment.commit || `Возврат покупки ${payment.id}`,
    rcvBankMemberId: BANK_MEMBER_ID,
  };

  // 🔹 Настраиваем PFX агент
  if (!process.env.CFT_PFX_BASE64 || !process.env.CFT_PFX_PASSWORD) {
    return res.status(500).json({ error: "PFX base64 or password not set in environment" });
  }

  const pfxBuffer = Buffer.from(process.env.CFT_PFX_BASE64, "base64");
  const agent = new https.Agent({
    pfx: pfxBuffer,
    passphrase: process.env.CFT_PFX_PASSWORD,
    rejectUnauthorized: true,
  });

  try {
    // 🔹 Отправляем POST запрос в банк
    const response = await fetch(BANK_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      agent,
    });

    const result = await response.json();

    // 🔹 Возвращаем ответ банка клиенту
    return res.status(response.status).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
