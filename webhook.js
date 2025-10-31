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

  console.log(`[${timestamp}] Webhook received:`, body);

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

    // 💾 Обновляем статус и commit в purchases
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

    // ⚙️ Если лимиты превышены — просто ставим success и уведомляем в Telegram
    if (refundReason) {
      console.log(`⚠️ Payment ${qrcId} превысил лимит: ${refundReason}`);

      // 💾 На всякий случай обновляем статус повторно
      const { error: fixErr } = await supabase
        .from("purchases")
        .update({
          status: "success",
          commit: commitMessage,
          updated_at: new Date().toISOString(),
        })
        .eq("qr_id", qrcId);

      if (fixErr) console.error("❌ Ошибка при обновлении статуса:", fixErr);

      // ✉️ Отправляем сообщение в Telegram
      const tgText = `
✅ *Возврат средств выполнен успешно!*
QR: \`${qrcId}\`
Партнёр: \`${sndPam || "N/A"}\`
Steam: \`N/A\`
Commit: \`${commitMessage || "N/A"}\`
Сумма: *${currentAmountRub} ₽*
Status: success
Дата: ${new Date().toLocaleString("ru-RU")}
`;

      try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: tgText,
          parse_mode: "Markdown",
        });

        console.log("📨 Telegram уведомление отправлено.");
      } catch (tgErr) {
        console.error("❌ Ошибка при отправке в Telegram:", tgErr.response?.data || tgErr.message);
      }

      return res.status(200).json({ result: "ok (refund replaced by TG notify)" });
    }

    console.log(`✅ Payment ${qrcId} marked as SUCCESS`);

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
      {
        headers: { apikey: "40a2cbac635f46a280a9e9fd7a5c5b20" },
      }
    );

    const exchangeRate = exchangeRes.data.exchange_rate;
    const steamAmount = odinOrder.amount / exchangeRate;

    console.log(`💱 Exchange rate: ${exchangeRate}, Steam amount: ${steamAmount}`);

    // 💰 Отправляем пополнение Steam
    const topupRes = await axios.post(
      "https://desslyhub.com/api/v1/service/steamtopup/topup",
      {
        amount: steamAmount,
        username: odinOrder.steam_login,
      },
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
