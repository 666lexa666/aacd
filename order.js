import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// 🧠 In-memory cache
const cache = {
  apiClients: { data: null, expires: 0 },
  availableLogins: { data: null, expires: 0 },
};

const CACHE_TTL = 10000; // 10 секунд

async function getApiClient(api_login, api_key) {
  const now = Date.now();
  if (cache.apiClients.data && cache.apiClients.expires > now) {
    return cache.apiClients.data.find(c => c.api_login === api_login && c.api_key === api_key) || null;
  }

  const { data, error } = await supabase.from("api_clients").select("api_login, api_key, test, trafic");
  if (error) throw error;

  cache.apiClients.data = data;
  cache.apiClients.expires = now + CACHE_TTL;

  return data.find(c => c.api_login === api_login && c.api_key === api_key) || null;
}

async function getAvailableLogin() {
  const now = Date.now();
  if (cache.availableLogins.data && cache.availableLogins.expires > now) {
    const logins = cache.availableLogins.data.filter(l => !l.used);
    if (!logins.length) throw new Error("No available logins left (cached)");
    const randomIndex = Math.floor(Math.random() * logins.length);
    return logins[randomIndex].login;
  }

  const { data: logins, error } = await supabase.from("available_logins").select("login, used");
  if (error) throw error;

  cache.availableLogins.data = logins;
  cache.availableLogins.expires = now + CACHE_TTL;

  const unused = logins.filter(l => !l.used);
  if (!unused.length) throw new Error("No available logins left");
  const randomIndex = Math.floor(Math.random() * unused.length);
  return unused[randomIndex].login;
}

function generateNumericId() {
  return Math.floor(10000000 + Math.random() * 90000000);
}

async function sendToSteamBackend(login, sum, apiLogin, apiKey, backendUrl) {
  const requestData = { steamId: login, amount: sum, api_login: apiLogin, api_key: apiKey };
  const backendRes = await fetch(`${backendUrl}/api/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestData),
  });
  if (!backendRes.ok) {
    const text = await backendRes.text();
    throw new Error(`Backend error: ${backendRes.status} ${text}`);
  }
  return backendRes.json();
}

// 🟢 Основной роут
router.post("/", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    let apiLogin = req.headers["x-api-login"];

    if (!apiKey && !apiLogin)
      return res.status(400).json({ error: "Missing API credentials" });

    // 🔎 Получаем API клиента с кэшем
    const client = await getApiClient(apiLogin, apiKey);
    if (!client) return res.status(401).json({ error: "Invalid API credentials" });

    if (!apiLogin) apiLogin = client.api_login;
    if (apiKey && apiKey !== client.api_key)
      return res.status(401).json({ error: "Invalid API credentials" });

    if (!client.trafic) return res.status(403).json({ error: "Запросите трафик" });

    const SECOND_SERVER_URL = client.test
      ? "https://test-qil8.onrender.com"
      : "https://steam-back.onrender.com";

    const { sum, client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "Missing client_id in request body" });
    if (typeof sum !== "number" || sum <= 0)
      return res.status(400).json({ error: "Invalid sum: must be positive number" });

    const { client_id: innerId, client_ip, client_phone, device_id } = client_id || {};
    const now = new Date().toISOString();

    // 1️⃣ Находим существующего master_id по любому идентификатору
    const { data: existingDevice } = await supabase
      .from("client_devices")
      .select("master_id")
      .or(
        [
          device_id ? `device_id.eq.${device_id}` : null,
          client_ip ? `client_ip.eq.${client_ip}` : null,
          client_phone ? `client_phone.eq.${client_phone}` : null,
        ].filter(Boolean).join(",")
      )
      .limit(1)
      .maybeSingle();

    let masterId;
    let steamLogin;

    if (existingDevice?.master_id) {
      masterId = existingDevice.master_id;

      // Проверяем, есть ли уже такое состояние устройства
      const { data: stateExists } = await supabase
        .from("client_devices")
        .select("id")
        .eq("master_id", masterId)
        .eq("device_id", device_id)
        .eq("client_ip", client_ip)
        .eq("client_phone", client_phone)
        .maybeSingle();

      if (!stateExists) {
        await supabase.from("client_devices").insert({
          master_id: masterId,
          device_id,
          client_ip,
          client_phone,
          created_at: now,
        });
      }

      // Берем существующего клиента
      const { data: existingClient } = await supabase
        .from("clients")
        .select("steam_login, total_amount, period_amount, id")
        .eq("master_id", masterId)
        .maybeSingle();

      steamLogin = existingClient.steam_login;
      let total_amount = (existingClient.total_amount || 0) + sum / 100;
      let period_amount = (existingClient.period_amount || 0) + sum / 100;

      // Проверка лимитов
      if (period_amount > 10000 || total_amount > 70000) {
        const exceededType = period_amount > 10000 ? "день" : "месяц";
        const remaining =
          period_amount > 10000
            ? 10000 - (existingClient.period_amount || 0)
            : 70000 - (existingClient.total_amount || 0);

        return res.status(200).json({
          status: "cancelled",
          info: `Превышен лимит суммы операций за ${exceededType}. Остаточный лимит ${Math.max(0, remaining)} рублей.`,
        });
      }

      // Обновляем суммы
      await supabase
        .from("clients")
        .update({
          total_amount,
          period_amount,
          updated_at: now,
        })
        .eq("id", existingClient.id);

    } else {
      // 2️⃣ Новый клиент
      steamLogin = await getAvailableLogin();
      const newClientId = generateNumericId();
      masterId = newClientId;

      await supabase.from("clients").insert({
        id: newClientId,
        master_id: masterId,
        client_id: innerId,
        api_login: apiLogin,
        steam_login: steamLogin,
        total_amount: sum / 100,
        period_amount: sum / 100,
        created_at: now,
        updated_at: now,
      });

      await supabase.from("client_devices").insert({
        master_id: masterId,
        device_id,
        client_ip,
        client_phone,
        created_at: now,
      });
    }

    // 3️⃣ Отправка на Steam backend
    const backendData = await sendToSteamBackend(
      steamLogin,
      sum,
      apiLogin,
      apiKey,
      SECOND_SERVER_URL
    );

    return res.status(200).json({
      results: {
        operation_id: backendData.result.operation_id,
        qr_id: backendData.result.qr_id,
        qr_link: backendData.result.qr_payload,
      },
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
