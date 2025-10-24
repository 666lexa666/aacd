import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import https from "https";
import fs from "fs";

const router = express.Router();

// 🔑 Supabase init
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 POST /api/order — регистрация QR в ЦФТ (продакшн)
router.post("/", async (req, res) => {
  try {
    const { steamId, amount, api_login, api_key } = req.body;

    // Проверка обязательных полей
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

    const operationId = uuidv4();
    const now = new Date().toISOString();

    // 🔧 Подготовка тела запроса для ЦФТ
    const qrRequestBody = {
      extEntityId: process.env.CFT_EXT_ENTITY_ID,
      merchantId: process.env.CFT_MERCHANT_ID,
      accAlias: process.env.CFT_ACC_ALIAS,
      amount: Number(amount),
      paymentPurpose: `Пополнение SteamID ${steamId}`,
      qrcType: "02",
      expDt: 5,
      localExpDt: 300,
    };

    // 🌐 Настройка HTTPS агента с pfx для TLS
    const pfxPath = "./cert/tsp1924.b101775.pfx";
    const pfxPassword = process.env.CFT_PFX_PASSWORD;

    const agent = new https.Agent({
      pfx: fs.readFileSync(pfxPath),
      passphrase: pfxPassword,
      rejectUnauthorized: true, // обязательно для продакшена
    });

    // 🌐 Отправка запроса в ЦФТ
    const qrResponse = await axios.post(
      process.env.CFT_PROD_URL || "https://prod.cft.ru/qr",
      qrRequestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authsp: process.env.CFT_PROD_AUTHSP || "prod-bank.ru",
        },
        timeout: 10000,
        httpsAgent: agent,
      }
    );

    const { qrcId, payload } = qrResponse.data;

    if (!qrcId || !payload) {
      return res.status(502).json({ error: "Invalid response from CFT" });
    }

    // 💾 Сохранение покупки в Supabase
    const { error: insertErr } = await supabase.from("purchases").insert([
      {
        id: operationId,
        user_id: null,
        steam_login: steamId,
        amount: Number(amount),
        status: "pending",
        api_login,
        qr_id: qrcId,
        qr_payload: payload,
        created_at: now,
        updated_at: now,
      },
    ]);

    if (insertErr) throw insertErr;

    // 🔗 Отправка QR-кода клиенту
    return res.status(201).json({
      result: {
        qr_id: qrcId,
        qr_payload: payload,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/order:", err);
    return res.status(500).json({ error: err?.message || "Internal Server Error" });
  }
});

export default router;
