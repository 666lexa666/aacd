import express from "express";
import cors from "cors";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

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

// 🔧 Вспомогательная функция отправки данных на второй сервер
async function sendToSteamBackend(steamLogin, sum, apiLogin, apiKey, url) {
  try {
    console.log(`📤 Отправка на Steam backend: steamLogin=${steamLogin}, sum=${sum}`);
    const { data } = await axios.post(`${url}/api/order`, {
      steamLogin,
      amount: sum,
      api_login: apiLogin,
      api_key: apiKey,
    });
    console.log("✅ Ответ Steam backend:", data);
    return data;
  } catch (err) {
    console.error("❌ Ошибка отправки на Steam backend:", err.message);
    return null;
  }
}

// 🧩 Главный маршрут
router.post("/", async (req, res) => {
  try {
    const { fingerprint, steamLogin, amount } = req.body;
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown";

    console.log("📥 Новый запрос:", { fingerprint, steamLogin, amount, clientIp });

    if (!fingerprint || !steamLogin || !amount) {
      console.warn("⚠️ Пропущенные обязательные поля");
      return res.status(400).json({ error: "Missing required fields" });
    }

    const apiLogin = "odin-god-steam";
    const apiKey =
      "f2b31d9aec0afd69dfce4cea332e6830d619e0219e20e78d86c02502fcca6a60";

    // ========== 1️⃣ Проверка в clients по fingerprint ==========
    console.log("🔍 Проверка clients по fingerprint");
    const { data: foundClient, error: clientErr } = await supabase
      .from("clients")
      .select("*")
      .eq("client_id", fingerprint)
      .maybeSingle();

    if (clientErr) {
      console.error("❌ Ошибка поиска клиента:", clientErr);
      return res.status(500).json({ error: "Database error" });
    }

    if (!foundClient) {
      console.log("❌ Fingerprint не найден, ищем по IP в client_devices");

      // ========== 2️⃣ Ищем IP в client_devices ==========
      const { data: foundDevice, error: deviceErr } = await supabase
        .from("client_devices")
        .select("*")
        .eq("client_ip", clientIp)
        .maybeSingle();

      if (deviceErr) console.error("❌ Ошибка поиска устройства по IP:", deviceErr);

      if (foundDevice) {
        console.log("ℹ️ Найдено устройство по IP, добавляем новый fingerprint");
        await supabase.from("client_devices").insert({
          master_id: foundDevice.master_id,
          device_id: fingerprint,
          client_ip: clientIp,
        });
      } else {
        console.log("❌ IP не найден, ищем fingerprint в device_id");

        // ========== 3️⃣ Ищем fingerprint в device_id ==========
        const { data: foundByFpDevice } = await supabase
          .from("client_devices")
          .select("*")
          .eq("device_id", fingerprint)
          .maybeSingle();

        if (foundByFpDevice) {
          const masterId = foundByFpDevice.master_id;

          const { data: devicesByMaster } = await supabase
            .from("client_devices")
            .select("client_ip")
            .eq("master_id", masterId);

          const hasIp = devicesByMaster?.some((d) => d.client_ip === clientIp);

          if (!hasIp) {
            console.log("ℹ️ IP не найден среди устройств master_id, добавляем новую запись");
            await supabase.from("client_devices").insert({
              master_id: masterId,
              device_id: fingerprint,
              client_ip: clientIp,
            });
          } else {
            console.log("ℹ️ IP уже существует среди устройств master_id");
          }
        } else {
          // ========== 4️⃣ Не нашли нигде → создаём нового клиента ==========
          console.log("🔹 Создаём нового клиента в clients");
          const { data: newClient, error: createErr } = await supabase
            .from("clients")
            .insert({
              client_id: fingerprint,
              api_login: apiLogin,
              steam_login: steamLogin,
            })
            .select("master_id")
            .single();

          if (createErr || !newClient) {
            console.error("❌ Ошибка создания нового клиента:", createErr);
            return res.status(500).json({ error: "Не удалось создать клиента" });
          }

          const masterId = newClient.master_id;

          console.log("ℹ️ Создаём запись в client_devices для нового клиента");
          await supabase.from("client_devices").insert({
            master_id: masterId,
            client_ip: clientIp,
            device_id: fingerprint,
          });
        }
      }
    } else {
      // ========== 5️⃣ fingerprint найден в clients ==========
      console.log("ℹ️ Fingerprint найден в clients");
      const masterId = foundClient.master_id;

      const { data: devices, error: devErr } = await supabase
        .from("client_devices")
        .select("client_ip")
        .eq("master_id", masterId);

      if (devErr) console.error("❌ Ошибка при проверке устройств:", devErr);

      const hasIp = devices?.some((d) => d.client_ip === clientIp);

      if (!hasIp) {
        console.log("ℹ️ IP не найден среди устройств master_id, добавляем новую запись");
        await supabase.from("client_devices").insert({
          master_id: masterId,
          client_ip: clientIp,
        });
      } else {
        console.log("ℹ️ IP уже зарегистрирован для данного master_id");
      }
    }

    // ✅ Отправляем данные на второй сервер
    console.log("📤 Отправляем данные на Steam backend");
    const backendData = await sendToSteamBackend(
      steamLogin,
      amount,
      apiLogin,
      apiKey,
      "https://steam-back.onrender.com"
    );

    console.log("✅ Клиент обработан успешно");
    res.status(200).json({
      message: "Client processed successfully",
      backendData,
    });
  } catch (err) {
    console.error("❌ Handler error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
