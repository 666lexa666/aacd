import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";

const router = express.Router();

// 🔑 Supabase init
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 POST /api/order — регистрация QR в песочнице ЦФТ
router.post("/", async (req, res) => {
  try {
    const { steamId, amount, api_login, api_key } = req.body;

    if (!steamId || !amount || !api_login || !api_key) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ ping-тест
    if (steamId === "ping") {
      return res.status(200).json({ result: "pong" });
    }

    // 🔍 Проверяем API-клиента
    const { data: client, error: clientErr } = await supabase
      .from("api_clients")
      .select("api_login, api_key")
      .eq("api_login", api_login)
      .eq("api_key", api_key)
      .maybeSingle();

    if (clientErr) throw clientErr;
    if (!client) {
      return res.status(401).json({ error: "Invalid API credentials" });
    }

    const now = new Date().toISOString();
    const operation_id = uuidv4();

    // 🔧 Подготовим тело запроса для API песочницы ЦФТ
    const qrRequestBody = {
      rqUid: operation_id,
      rqTm: now,
      merchantId: "MB0002029281", // ⚙️ Твой merchantId из таблицы
      amount: Number(amount),
      currency: "RUB",
      purpose: `Пополнение SteamID ${steamId}`,
      qrType: "QRDynamic",
      redirectUrl: `https://yourdomain.com/sbp/callback/${operation_id}`, // callback
    };

    // 🌐 Отправляем запрос в песочницу ЦФТ (без TLS)
    const { data: qrResponse } = await axios.post(
      "https://ahmad.ftc.ru:10400/qr",
      qrRequestBody,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      }
    );

    // 🧾 Ответ от ЦФТ
    const { qrId, payload } = qrResponse;

    // 💾 Сохраняем запись в БД
    const { error: insertErr } = await supabase.from("purchases").insert([
      {
        id: operation_id,
        user_id: null,
        steam_login: steamId,
        amount,
        status: "pending",
        api_login,
        qr_id: qrId,
        qr_payload: payload,
        created_at: now,
        updated_at: now,
      },
    ]);

    if (insertErr) throw insertErr;

    // 🔗 Отправляем QR клиенту
    return res.json({
      result: {
        qr_id: qrId,
        qr_payload: payload,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/order:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
