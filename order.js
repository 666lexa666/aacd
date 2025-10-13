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
    const { steamId, amount } = req.body;

    if (!steamId || !amount) {
      return res.status(400).json({ error: "Missing steamId or amount" });
    }

    // ✅ Если пришёл ping, просто возвращаем 200 OK
    if (steamId === "ping") {
      return res.status(200).json({ result: "pong" });
    }

    // 📅 UTC время
    const now = new Date().toISOString();

    // 🔍 Ищем user_id по steam_login
    const { data: user, error: userErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("steam_login", steamId)
      .maybeSingle();

    if (userErr) throw userErr;

    // 🎟️ Генерация ID и ссылки на оплату
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
      created_at: now,
      updated_at: now,
    };

    const { error: insertErr } = await supabase
      .from("purchases")
      .insert([newPurchase]);

    if (insertErr) throw insertErr;

    // 🧾 Ответ
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
