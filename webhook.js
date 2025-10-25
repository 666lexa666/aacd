import express from "express";
import axios from "axios";
import https from "https";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

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

    // 🧮 Считаем сумму за день и месяц
    let totalDay = 0;
    let totalMonth = 0;

    for (const p of payments || []) {
      const created = new Date(p.created_at);
      const createdUTC3 = new Date(created.getTime() + 3 * 60 * 60 * 1000);
      if (createdUTC3 >= startOfDay) totalDay += p.amount;
      if (createdUTC3 >= startOfMonth) totalMonth += p.amount;
    }

    // Добавляем текущую сумму (в рублях)
    const currentAmountRub = Number(amount) / 100;
    totalDay += currentAmountRub;
    totalMonth += currentAmountRub;

    console.log(
      `💰 User: ${sndPam} (${sndPhoneMasked}) | Day total: ${totalDay}₽ | Month total: ${totalMonth}₽`
    );

    // 🔒 Проверка лимитов
    const dayLimit = 10_000;
    const monthLimit = 100_000;

    let refundReason = null;
    let statusToSet = null; // null — оставляем прежний

    if (totalDay > dayLimit) {
      refundReason = `Превышен дневной лимит суммы операций (${dayLimit.toLocaleString()}₽)`;
      statusToSet = "refund";
    } else if (totalMonth > monthLimit) {
      refundReason = `Превышен месячный лимит суммы операций (${monthLimit.toLocaleString()}₽)`;
      statusToSet = "refund";
    } else {
      // Лимит не превышен, оставляем success
      statusToSet = "success";
    }

    // 💾 Обновляем запись в БД только если нужно
    if (statusToSet) {
      const { error: updateErr } = await supabase
        .from("purchases")
        .update({
          sndpam: sndPam,
          payer_phone: sndPhoneMasked,
          status: statusToSet,
          updated_at: new Date().toISOString(),
        })
        .eq("qr_id", qrcId);

      if (updateErr) throw updateErr;
    }

    // 🔁 Если превышен лимит — делаем возврат через ЦФТ
    if (refundReason) {
      console.log(`🔁 Initiating refund for ${qrcId}: ${refundReason}`);

      const refundBody = {
        longWait: false,
        internalTxId: uuidv4().replace(/-/g, "").slice(0, 32),
        refId: `refund-${qrcId}`,
        refType: "qrcId",
        refData: qrcId,
        remitInfo: refundReason,
      };

      const pfxBuffer = Buffer.from(process.env.CFT_PFX_BASE64, "base64");
      const agent = new https.Agent({
        pfx: pfxBuffer,
        passphrase: process.env.CFT_PFX_PASSWORD,
        rejectUnauthorized: true,
      });

      try {
        const refundRes = await axios.post(
          process.env.CFT_REFUND_URL,
          refundBody,
          {
            headers: {
              "Content-Type": "application/json",
              authsp: process.env.CFT_PROD_AUTHSP || "socium-bank.ru",
            },
            httpsAgent: agent,
            timeout: 15000,
          }
        );

        console.log(
          `✅ Refund ${qrcId} completed:`,
          `internalTxId=${refundRes.data.internalTxId}`,
          `status=${refundRes.data.status}`,
          `amount=${refundRes.data.amount}`
        );

        // Если возврат успешен — ставим refund
        if (refundRes.data.status === 0) {
          await supabase
            .from("purchases")
            .update({ status: "refund", updated_at: new Date().toISOString() })
            .eq("qr_id", qrcId);
        }
      } catch (refundErr) {
        if (refundErr.response) {
          console.error(
            "❌ Refund request failed with response:",
            refundErr.response.status,
            refundErr.response.data
          );

          // Если 502 — помечаем pending_refund
          if (refundErr.response.status === 502) {
            await supabase
              .from("purchases")
              .update({
                status: "pending_refund",
                updated_at: new Date().toISOString(),
              })
              .eq("qr_id", qrcId);
          }
        } else if (refundErr.request) {
          console.error(
            "❌ Refund request sent but no response received:",
            refundErr.request
          );
        } else {
          console.error("❌ Refund request setup error:", refundErr.message);
        }
      }
    } else {
      console.log(`✅ Payment ${qrcId} marked as SUCCESS`);
    }

    return res.status(200).json({ result: "ok" });
  } catch (err) {
    console.error("❌ Webhook processing failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
