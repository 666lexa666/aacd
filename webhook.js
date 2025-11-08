import express from "express";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";

const router = express.Router();
router.use(express.json());

// 🔑 Подключаем Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📦 Основной webhook
router.post("/", async (req, res) => {
  const timestamp = new Date().toISOString();
  const body = req.body;

  console.log(`[${timestamp}] 📥 Webhook received:`, body);

  try {
    const { amount, qrcId, sndPam, sndPhoneMasked } = body;

    if (!qrcId || !sndPam || !sndPhoneMasked || !amount) {
      console.warn("❌ Missing required fields in webhook");
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🔍 Ищем текущий платеж по qrcId
    const { data: currentPayment, error: findErr } = await supabase
      .from("purchases")
      .select("id, amount, created_at, status")
      .eq("qr_id", qrcId)
      .maybeSingle();

    if (findErr) throw findErr;
    if (!currentPayment) {
      console.warn(`⚠️ Payment not found for qr_id = ${qrcId}`);
      return res.status(404).json({ error: "Payment not found" });
    }

    const purchaseId = currentPayment.id;

    // 🕒 Работаем в UTC+3
    const now = new Date();
    const utc3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const startOfDay = new Date(utc3);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(utc3.getFullYear(), utc3.getMonth(), 1);

    // 🔎 Берём все успешные платежи за этот месяц/день (кроме текущего)
    const { data: payments, error: paymentsErr } = await supabase
      .from("purchases")
      .select("amount, created_at")
      .eq("sndpam", sndPam)
      .eq("payer_phone", sndPhoneMasked)
      .eq("status", "success")
      .neq("qr_id", qrcId);

    if (paymentsErr) throw paymentsErr;

    // 🧮 Считаем сумму за день и месяц (без текущей)
    let totalDayWithoutCurrent = 0;
    let totalMonthWithoutCurrent = 0;

    for (const p of payments || []) {
      const created = new Date(p.created_at);
      const createdUTC3 = new Date(created.getTime() + 3 * 60 * 60 * 1000);
      if (createdUTC3 >= startOfDay) totalDayWithoutCurrent += p.amount;
      if (createdUTC3 >= startOfMonth) totalMonthWithoutCurrent += p.amount;
    }

    const currentAmountRub = Number(amount) / 100;
    const totalDay = totalDayWithoutCurrent + currentAmountRub;
    const totalMonth = totalMonthWithoutCurrent + currentAmountRub;

    console.log(
      `💰 User: ${sndPam} (${sndPhoneMasked}) | Day total: ${totalDay}₽ | Month total: ${totalMonth}₽`
    );

    // 🔒 Проверка лимитов
    const dayLimit = 10_000;
    const monthLimit = 100_000;

    let refundReason = null;
    let newStatus = "success";
    let commitMessage = null;

    if (totalDay > dayLimit) {
      const remaining = dayLimit - totalDayWithoutCurrent;
      refundReason = `Превышен дневной лимит (${dayLimit}₽)`;
      commitMessage = `Превышен лимит суммы операций в день. Остаточный лимит ${remaining}₽.`;
    } else if (totalMonth > monthLimit) {
      const remaining = monthLimit - totalMonthWithoutCurrent;
      refundReason = `Превышен месячный лимит (${monthLimit}₽)`;
      commitMessage = `Превышен лимит суммы операций в месяц. Остаточный лимит ${remaining}₽.`;
    }

    // 💾 Обновляем purchases
    const { error: updateErr } = await supabase
      .from("purchases")
      .update({
        sndpam: sndPam,
        payer_phone: sndPhoneMasked,
        status: newStatus,
        commit: commitMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("qr_id", qrcId);

    if (updateErr) throw updateErr;

    // 👥 Обновление данных клиента
    try {
      const { data: purchaseWithLogin } = await supabase
        .from("purchases")
        .select("steam_login")
        .eq("qr_id", qrcId)
        .maybeSingle();

      if (purchaseWithLogin?.steam_login) {
        const steamLogin = purchaseWithLogin.steam_login;
        const { data: existingClient } = await supabase
          .from("clients")
          .select("id, payer_phone, sndpam")
          .eq("steam_login", steamLogin)
          .maybeSingle();

        if (existingClient && (!existingClient.payer_phone || !existingClient.sndpam)) {
          await supabase
            .from("clients")
            .update({
              payer_phone: sndPhoneMasked,
              sndpam: sndPam,
              updated_at: new Date().toISOString(),
            })
            .eq("steam_login", steamLogin);

          console.log(`👤 Client ${steamLogin} synced with phone & sndpam`);
        }
      }
    } catch (syncErr) {
      console.error("⚠️ Error syncing client data:", syncErr.message);
    }

    // ⚙️ Если превышен лимит — вместо Telegram вызываем REFUND
    if (refundReason) {
      console.log(`🚫 Payment ${qrcId} превысил лимит: ${refundReason}`);
      console.log(`➡️ Отправляем запрос на возврат для ${qrcId}`);

      try {
        const refundResponse = await axios.post(
          "https://refund-t62z.onrender.com/refund",
          { qrc_id: qrcId },
          { headers: { "Content-Type": "application/json" }, timeout: 20000 }
        );

        console.log("✅ REFUND API ответ:", refundResponse.status, refundResponse.data);

        return res.status(200).json({
          result: "refund_initiated",
          refund_status: refundResponse.status,
          refund_response: refundResponse.data,
        });
      } catch (refundErr) {
        console.error(
          "❌ Ошибка при вызове refund API:",
          refundErr.response?.data || refundErr.message
        );
        return res.status(502).json({
          error: "refund_failed",
          message: refundErr.message,
          data: refundErr.response?.data,
        });
      }
    }

    console.log(`✅ Payment ${qrcId} marked as SUCCESS, no limits exceeded.`);

    // 🔍 Ищем во второй таблице запись по id из purchases
    const { data: odinOrder, error: odinErr } = await supabase
      .from("odin_orders_history")
      .select("id, steam_login, amount")
      .eq("id", purchaseId)
      .maybeSingle();

    if (odinErr) throw odinErr;

    if (!odinOrder) {
      console.log(`ℹ️ Odin order not found for id = ${purchaseId}, skipping Steam topup`);
      return res.status(200).json({ result: "ok" });
    }

    // 🟢 Обновляем статус во второй таблице
    await supabase
      .from("odin_orders_history")
      .update({ status: "success" })
      .eq("id", purchaseId);

    // ⚡ Получаем курс Steam
    const exchangeRes = await axios.get(
      "https://desslyhub.com/api/v1/exchange_rate/steam/5",
      { headers: { apikey: "40a2cbac635f46a280a9e9fd7a5c5b20" } }
    );

    const exchangeRate = exchangeRes.data.exchange_rate;
    const steamAmount = odinOrder.amount / exchangeRate;

    console.log(`💱 Exchange rate: ${exchangeRate}, Steam amount: ${steamAmount}`);

    // 💰 Отправляем пополнение Steam
    const topupRes = await axios.post(
      "https://desslyhub.com/api/v1/service/steamtopup/topup",
      { amount: steamAmount, username: odinOrder.steam_login },
      {
        headers: {
          apikey: "40a2cbac635f46a280a9e9fd7a5c5b20",
          "content-type": "application/json",
        },
      }
    );

    console.log("🎮 Steam topup result:", topupRes.data);

    return res.status(200).json({
      result: "ok",
      steam_transaction: topupRes.data,
    });
  } catch (err) {
    console.error("❌ Webhook processing failed:", err.response?.data || err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
