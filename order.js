import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import https from "https";

const router = express.Router();

// 🔑 Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 POST /api/order — регистрация QR в ЦФТ (продакшн)
router.post("/", async (req, res) => {
  try {
    const { steamId, amount, api_login, api_key } = req.body;

    // ✅ Проверка обязательных полей
    if (!steamId || !amount || !api_login || !api_key) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Ping-тест
    if (steamId === "ping") {
      return res.status(200).json({ result: "pong" });
    }

    // 🔍 Проверка API-клиента в Supabase
    const { data: client, error: clientErr } = await supabase
      .from("api_clients")
      .select("api_login, api_key")
      .eq("api_login", api_login)
      .eq("api_key", api_key)
      .maybeSingle();

    if (clientErr) throw clientErr;
    if (!client) return res.status(401).json({ error: "Invalid API credentials" });

    // 🧾 Генерация operation_id
    const operationId = uuidv4();
    const now = new Date().toISOString();

    // 🔧 Подготовка тела запроса для ЦФТ
    const qrRequestBody = {
      extEntityId: process.env.CFT_EXT_ENTITY_ID,
      merchantId: process.env.CFT_MERCHANT_ID,
      accAlias: process.env.CFT_ACC_ALIAS,
      amount: Number(amount),
      paymentPurpose: `Odin-god-steam - Пополнение Steam ${steamId}`,
      qrcType: "02",
      expDt: 5,
      localExpDt: 300,
    };

    // 🌐 PFX сертификат из base64 (Render Secret)
    if (!process.env.CFT_PFX_BASE64 || !process.env.CFT_PFX_PASSWORD) {
      return res.status(500).json({ error: "PFX base64 or password not set in environment" });
    }

    const pfxBuffer = Buffer.from(process.env.CFT_PFX_BASE64, "base64");

    const agent = new https.Agent({
      pfx: pfxBuffer,
      passphrase: process.env.CFT_PFX_PASSWORD,
      rejectUnauthorized: true,
    });

    // 🌐 Отправка запроса в ЦФТ
    const cftUrl = process.env.CFT_PROD_URL || "https://zkc2b-socium.koronacard.ru/points/qr";

    console.log("🚀 Отправляем запрос в ЦФТ:", cftUrl, qrRequestBody);

    const qrResponse = await axios.post(cftUrl, qrRequestBody, {
      headers: {
        "Content-Type": "application/json",
        authsp: process.env.CFT_PROD_AUTHSP || "socium-bank.ru",
      },
      timeout: 10000,
      httpsAgent: agent,
    });

    console.log("📥 Ответ от ЦФТ:", JSON.stringify(qrResponse.data, null, 2));

    const { qrcId, payload } = qrResponse.data;

    if (!qrcId || !payload) {
      return res.status(502).json({ error: "Invalid response from CFT" });
    }

    // 💾 Сохраняем запись в Supabase
    const { error: insertErr } = await supabase.from("purchases").insert([
      {
        id: String(operationId),
        steam_login: steamId,
        amount: Number(amount/100),
        status: "pending",
        api_login,
        qr_id: qrcId,
        qr_payload: payload,
        created_at: now,
        updated_at: now,
      },
    ]);

    if (insertErr) throw insertErr;

    // ✅ Возвращаем клиенту данные
    return res.status(201).json({
      result: {
        operation_id: String(operationId), // наш UUID
        qr_id: qrcId,              // от ЦФТ
        qr_payload: payload,       // ссылка на QR
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/order:", err.response?.data || err.message);
    return res.status(500).json({
      error:
        err.response?.data?.error ||
        err.message ||
        "Internal Server Error",
    });
  }
});

export default router;
