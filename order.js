import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import https from "https";

const router = express.Router();

// 🟢 Настройка CORS
router.use(
  cors({
    origin: "https://odin-god-steam.ru",
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// 🔑 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📬 Telegram настройки
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 🧠 Хелпер для уведомления в Telegram
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("❌ Ошибка отправки Telegram:", err.response?.data || err.message);
  }
}

// 📦 POST /api/order
router.post("/", async (req, res) => {
  try {
    const {
      steamId,
      amount,
      api_login,
      api_key,

      // ✅ Новые поля из запроса
      innerId,
      client_ip,
      client_phone,
      device_id,
    } = req.body;

    if (!steamId || !amount || !api_login || !api_key) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🧩 Ping-тест
    if (steamId === "ping") return res.status(200).json({ result: "pong" });

    // 🔍 Проверка API-клиента
    const { data: client, error: clientErr } = await supabase
      .from("api_clients")
      .select("api_login, api_key")
      .eq("api_login", api_login)
      .eq("api_key", api_key)
      .maybeSingle();

    if (clientErr) throw clientErr;
    if (!client) return res.status(401).json({ error: "Invalid API credentials" });

    // 🔧 Проверка Steam логина для odin-god-steam
    if (api_login === "odin-god-steam") {
      try {
        const checkLoginRes = await axios.post(
          "https://desslyhub.com/api/v1/service/steamtopup/check_login",
          { amount: 1, username: steamId },
          {
            headers: {
              apikey: "40a2cbac635f46a280a9e9fd7a5c5b20",
              "content-type": "application/json",
            },
          }
        );

        if (!checkLoginRes.data.can_refill) {
          console.warn(`❌ Steam login invalid: ${steamId}`);
          return res.status(300).json({
            error: "Invalid Steam login",
            code: checkLoginRes.data.error_code || -1,
          });
        }

        console.log(`✅ Steam login valid: ${steamId}`);
      } catch (err) {
        console.error("❌ Ошибка проверки Steam логина:", err.response?.data || err.message);
        return res.status(500).json({ error: "Failed to check Steam login" });
      }
    }

    // 🧾 Генерация operation_id
    const operationId = uuidv4();
    const now = new Date().toISOString();

    // 🧠 Если это odin-god-steam — логируем в историю и Telegram
    if (api_login === "odin-god-steam") {
      // 💾 Добавляем запись в таблицу odin_orders_history
      await supabase.from("odin_orders_history").insert([
        {
          id: operationId,
          steam_login: steamId,
          amount: Number(amount / 100),
          created_at: now,
        },
      ]);

      // 📲 Уведомление в Telegram
      await sendTelegramMessage(
        `⚡ <b>Новый заказ ODIN-GOD-STEAM</b>\n\n👤 Steam ID: <code>${steamId}</code>\n💰 Сумма: <b>${amount / 100}₽</b>\n🕒 ${now}`
      );
    }

    // 🔧 Тело запроса для ЦФТ
    const qrRequestBody = {
      extEntityId: process.env.CFT_EXT_ENTITY_ID,
      merchantId: process.env.CFT_MERCHANT_ID,
      accAlias: process.env.CFT_ACC_ALIAS,
      amount: Number(amount),
      paymentPurpose: `оплата товара в магазине 7-eleven`,
      qrcType: "02",
      expDt: 25,
      localExpDt: 1500,
    };

    if (!process.env.CFT_PFX_BASE64 || !process.env.CFT_PFX_PASSWORD) {
      return res.status(500).json({ error: "PFX base64 or password not set in environment" });
    }

    const pfxBuffer = Buffer.from(process.env.CFT_PFX_BASE64, "base64");

    const agent = new https.Agent({
      pfx: pfxBuffer,
      passphrase: process.env.CFT_PFX_PASSWORD,
      rejectUnauthorized: true,
    });

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
    if (!qrcId || !payload) return res.status(502).json({ error: "Invalid response from CFT" });

    // 💾 Запись в purchases
    const { error: insertErr } = await supabase.from("purchases").insert([
      {
        id: operationId,
        steam_login: steamId,
        amount: Number(amount / 100),
        status: "pending",
        api_login,
        qr_id: qrcId,
        qr_payload: payload,
        created_at: now,
        updated_at: now,

        // ✅ Добавляем данные из запроса
        inner_id: innerId ?? null,
        client_ip: client_ip ?? null,
        client_phone: client_phone ?? null,
        device_id: device_id ?? null,
      },
    ]);

    if (insertErr) throw insertErr;

    // ✅ Ответ клиенту
    return res.status(201).json({
      result: {
        operation_id: operationId,
        qr_id: qrcId,
        qr_payload: payload,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/order:", err.response?.data || err.message);
    return res.status(500).json({
      error: err.response?.data?.error || err.message || "Internal Server Error",
    });
  }
});

export default router;
