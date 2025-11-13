import express from "express";
import cors from "cors";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

// ✅ Разрешаем запросы только с твоего домена
router.use(
  cors({
    origin: "https://odin-god-steam.ru",
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// 🔑 Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔧 Вспомогательная функция отправки данных на Steam backend
async function sendToSteamBackend(steamLogin, amount, apiLogin, apiKey, url) {
  try {
    console.log(`📤 Отправка на Steam backend: steamId=${steamLogin}, amount=${amount}`);
    const { data } = await axios.post(`${url}/api/order`, {
      steamId: steamLogin,
      amount,
      api_login: apiLogin,
      api_key: apiKey,
    });
    return data;
  } catch (err) {
    console.error("❌ Ошибка отправки на Steam backend:", err.message);
    if (err.response) console.error("📄 Ответ сервера:", err.response.data);
    return null;
  }
}

// 🔥 Лимиты
const MAX_TOTAL = 20000; // максимум за всё время
const MAX_PERIOD = 10000; // максимум за период (например, сутки)

router.post("/", async (req, res) => {
  try {
    const { fingerprint, steamLogin, amount } = req.body;
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown";

    if (!fingerprint || !steamLogin || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const apiLogin = "odin-god-steam";
    const apiKey = "f2b31d9aec0afd69dfce4cea332e6830d619e0219e20e78d86c02502fcca6a60";

    // 🔍 Проверяем клиента по fingerprint
    let { data: foundClient } = await supabase
      .from("clients")
      .select("*")
      .eq("client_id", fingerprint)
      .maybeSingle();

    let masterId;

    if (!foundClient) {
      // Ищем IP в client_devices
      let { data: foundDevice } = await supabase
        .from("client_devices")
        .select("*")
        .eq("client_ip", clientIp)
        .maybeSingle();

      if (foundDevice) {
        // Добавляем новый fingerprint к найденному устройству
        await supabase.from("client_devices").insert({
          master_id: foundDevice.master_id,
          device_id: fingerprint,
          client_ip: clientIp,
        });
        masterId = foundDevice.master_id;
      } else {
        // Ищем fingerprint в device_id
        let { data: foundByFpDevice } = await supabase
          .from("client_devices")
          .select("*")
          .eq("device_id", fingerprint)
          .maybeSingle();

        if (foundByFpDevice) {
          const devicesByMaster = await supabase
            .from("client_devices")
            .select("client_ip")
            .eq("master_id", foundByFpDevice.master_id);

          const hasIp = devicesByMaster.data?.some((d) => d.client_ip === clientIp);
          if (!hasIp) {
            await supabase.from("client_devices").insert({
              master_id: foundByFpDevice.master_id,
              device_id: fingerprint,
              client_ip: clientIp,
            });
          }
          masterId = foundByFpDevice.master_id;
        } else {
          // Создаём нового клиента
          let { data: newClient } = await supabase
            .from("clients")
            .insert({
              client_id: fingerprint,
              api_login: apiLogin,
              steam_login: steamLogin,
              total_amount: 0,
              period_amount: 0,
            })
            .select("master_id")
            .single();
          masterId = newClient.master_id;

          await supabase.from("client_devices").insert({
            master_id: masterId,
            device_id: fingerprint,
            client_ip: clientIp,
          });
        }
      }
    } else {
      masterId = foundClient.master_id;

      // Проверяем, есть ли уже IP
      let { data: devices } = await supabase
        .from("client_devices")
        .select("client_ip")
        .eq("master_id", masterId);

      const hasIp = devices?.some((d) => d.client_ip === clientIp);
      if (!hasIp) {
        await supabase.from("client_devices").insert({
          master_id: masterId,
          client_ip: clientIp,
        });
      }
    }

    // 🔥 Проверяем лимиты
    let { data: masterClient } = await supabase
      .from("clients")
      .select("total_amount, period_amount, steam_login")
      .eq("master_id", masterId)
      .maybeSingle();

    const currentTotal = masterClient?.total_amount || 0;
    const currentPeriod = masterClient?.period_amount || 0;
    const newTotal = currentTotal + amount/100;
    const newPeriod = currentPeriod + amount/100;

    if (newTotal > MAX_TOTAL || newPeriod > MAX_PERIOD) {
      // Telegram уведомление
      const tgMessage = `
⚠️ <b>💳 Payment Blocked!</b>
🆔 client_id: ${fingerprint}
🧑‍💼 master_id: ${masterId}
🎮 steam_login: ${masterClient?.steam_login || "N/A"}
🌐 Client IP: ${clientIp}
💸 Attempted payment: ${amount}
📊 Total after payment: ${newTotal} / ${MAX_TOTAL}
⏱ Period after payment: ${newPeriod} / ${MAX_PERIOD}
`;
      try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: tgMessage,
          parse_mode: "HTML",
        });
      } catch (err) {
        console.error("❌ Telegram error:", err.message);
      }

      return res.status(403).json({
        error: "Payment exceeds allowed limit",
        total_amount: newTotal,
        period_amount: newPeriod,
        max_total: MAX_TOTAL,
        max_period: MAX_PERIOD,
      });
    }

    // Обновляем totals
    await supabase
      .from("clients")
      .update({
        total_amount: newTotal,
        period_amount: newPeriod,
      })
      .eq("master_id", masterId);

    // ✅ Отправляем данные на Steam backend
    const backendData = await sendToSteamBackend(
      steamLogin,
      amount,
      apiLogin,
      apiKey,
      "https://steam-back.onrender.com"
    );

    if (!backendData?.result?.qr_payload) {
      return res.status(502).json({ error: "Invalid response from Steam backend" });
    }

    return res.status(200).json({ qr_payload: backendData.result.qr_payload });
  } catch (err) {
    console.error("❌ Handler error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
