import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// 🔑 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 POST /api/order
router.post("/", async (req, res) => {
  try {
    const { steamId, amount, api_login, api_key } = req.body;

    // ✅ Проверка обязательных полей
    if (!steamId || !amount || !api_login || !api_key) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Если это ping-запрос
    if (steamId === "ping") {
      return res.status(200).json({ result: "pong" });
    }

    // 🔍 Проверяем клиента в таблице api_clients
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

    // 📅 Время
    const now = new Date().toISOString();

    // 🔍 Ищем пользователя по steam_login
    const { data: user, error: userErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("steam_login", steamId)
      .maybeSingle();

    if (userErr) throw userErr;

    // 🎟️ Генерация ID и ссылки
    const operation_id = uuidv4();
    const nspk = `https://pay.nspk.ru/${operation_id}`;

    // 💾 Запись в purchases
    const newPurchase = {
      id: operation_id,
      user_id: user ? user.id : null,
      steam_login: steamId,
      amount,
      status: "pending",
      nspk,
      api_login, // 👈 сохраняем, кто сделал запрос
      created_at: now,
      updated_at: now,
    };

    const { error: insertErr } = await supabase
      .from("purchases")
      .insert([newPurchase]);

    if (insertErr) throw insertErr;

    // 🧾 Ответ клиенту
    return res.json({
      result: {
        qr_link: nspk,
        operation_id,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/order:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
