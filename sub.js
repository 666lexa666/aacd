import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// 🔑 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 POST /api/sub
router.post("/", async (req, res) => {
  try {
    const { steamId } = req.body;
    if (!steamId) return res.status(400).json({ error: "Missing steamId" });

    const now = new Date().toISOString();

    const { data: user, error: userErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("steam_login", steamId)
      .maybeSingle();

    if (userErr) throw userErr;

    const operation_id = uuidv4();
    const nspk = `https://pay.nspk.ru/${operation_id}`;

    const newPurchase = {
      id: operation_id,
      user_id: user ? user.id : null,
      steam_login: steamId,
      amount: 200,
      status: "pending",
      nspk,
      created_at: now,
      updated_at: now,
    };

    const { error: insertErr } = await supabase
      .from("purchases")
      .insert([newPurchase]);

    if (insertErr) throw insertErr;

    return res.json({
      result: {
        qr_link: nspk,
        operation_id,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка /api/sub:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
