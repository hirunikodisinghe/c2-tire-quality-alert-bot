const oracledb = require("oracledb");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");


require("dotenv").config();

const oracleConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECT_STRING
};

const CHECK_INTERVAL_MS = 60_000;
const GROUP_NAME = "ST3 C2 tires";

// Prevent duplicate sends during one process run
const sentKeys = new Set();

let isWhatsAppReady = false;
let monitorInterval = null;
let resolvedGroupId = null;
let isCheckingAlerts = false;

// =========================
// WHATSAPP CLIENT
// =========================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "quality-bot",
    dataPath: path.join(__dirname, ".wwebjs_auth")
  }),

  puppeteer: {
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  }
});

client.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated.");
});

client.on("auth_failure", (msg) => {
  isWhatsAppReady = false;
  resolvedGroupId = null;
  console.error("WhatsApp auth failure:", msg);
});

client.on("ready", async () => {
  try {
    isWhatsAppReady = true;
    console.log("WhatsApp Web is ready.");

    const state = await safeGetClientState();
    console.log("WhatsApp state:", state);

    await testOracleConnection();
    await resolveTargetGroupId();

    startMonitoring();
  } catch (err) {
    console.error("Error during ready handler:", err);
  }
});

client.on("disconnected", (reason) => {
  isWhatsAppReady = false;
  resolvedGroupId = null;
  console.error("WhatsApp disconnected:", reason);

  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
});

client.on("change_state", (state) => {
  console.log("WhatsApp state changed:", state);
});

// =========================
// HELPERS
// =========================

function formatValue(value) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mi = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  return String(value);
}

function buildRowKey(row) {
  return `${row.BARCODE_ID}|${formatValue(row.CREATED_DATE)}|${row.GRADE}`;
}

function buildMessage(row) {
  const defects = [
    row.DEFECT1_DESC,
    row.DEFECT2_DESC,
    row.DEFECT3_DESC,
    row.DEFECT4_DESC
  ].filter(d => d && String(d).trim() !== "");

  const defectText = defects.length
    ? defects.map(d => `🔹 ${d}`).join("\n")
    : "🔹 No defect description";

  return `🚨 *C2 Tire Quality Alert*

📦 *Order Details*
🔹 Order No : ${row.ORDER_NO ?? ""}
🔹 Serial No : ${row.SERIAL_NO ?? ""}
🔹 Barcode : ${row.BARCODE_ID ?? ""}

🏭 *Production Info*
🔹 Part No : ${row.PART_NO ?? ""}
🔹 Description : ${row.PART_DESCRIPTION ?? ""}
🔹 Shift Time : ${row.SHIFT_TIME_ID ?? ""}
🔹 Employee : ${row.EMP_NO1 ?? ""}

⚠️ *Defects*
${defectText}

🏭 *Curing Press*
🔹 ${row.PRESS_NO ?? ""}

🕒 *Record Info*
🔹 Created Date : ${formatValue(row.CREATED_DATE)}
🔹 Created By : ${row.CREATED_BY ?? ""}`;
}

async function safeGetClientState() {
  try {
    return await client.getState();
  } catch (err) {
    console.warn("Could not get WhatsApp state:", err.message);
    return "UNKNOWN";
  }
}

async function ensureWhatsAppReady() {
  if (!isWhatsAppReady) {
    throw new Error("WhatsApp client is not ready.");
  }

  const state = await safeGetClientState();

  // Allowing OPENING/PAIRING can be flaky for sending; CONNECTED is safest
  if (state && state !== "CONNECTED") {
    throw new Error(`WhatsApp is not connected. Current state: ${state}`);
  }
}

async function resolveTargetGroupId(forceRefresh = false) {
  if (!forceRefresh && resolvedGroupId) {
    return resolvedGroupId;
  }

  await ensureWhatsAppReady();

  const chats = await client.getChats();
  const group = chats.find(chat => chat.isGroup && chat.name === GROUP_NAME);

  if (!group) {
    throw new Error(`Group not found: ${GROUP_NAME}`);
  }

  resolvedGroupId = group.id._serialized;
  console.log(`Resolved group "${GROUP_NAME}" to ID: ${resolvedGroupId}`);

  return resolvedGroupId;
}

async function sendToGroup(message) {
  await ensureWhatsAppReady();

  try {
    const groupId = await resolveTargetGroupId(false);
    await client.sendMessage(groupId, message);
    console.log("Message sent to:", GROUP_NAME);
    return true;
  } catch (err) {
    console.warn("First send attempt failed, refreshing group cache:", err.message);

    // Retry once after forcing a fresh lookup
    resolvedGroupId = null;
    const groupId = await resolveTargetGroupId(true);
    await client.sendMessage(groupId, message);
    console.log("Message sent to:", GROUP_NAME);
    return true;
  }
}

// =========================
// ORACLE FUNCTIONS
// =========================

async function testOracleConnection() {
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    const result = await connection.execute(
      `SELECT COUNT(*) CNT
       FROM ifsapp.c_tire_manuf_proc_ovw
       WHERE created_date >= TRUNC(SYSDATE)`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    console.log("Oracle connected.");
    console.log("Today's rows:", result.rows[0].CNT);
  } catch (err) {
    console.error("Oracle connection failed:", err);
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error("Failed to close Oracle connection:", closeErr);
      }
    }
  }
}

async function loadNewAlertRows() {
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    const sqlText = `
      SELECT
        ORDER_NO,
        SERIAL_NO,
        SHIFT_TIME_ID,
        EMP_NO1,
        BARCODE_ID,
        PART_NO,
        PART_DESCRIPTION,
        CREATED_DATE,
        CREATED_BY,
        PRESS_NO,
        GRADE,

        C_Defect_API.Get_Description(site, defect1) DEFECT1_DESC,
        C_Defect_API.Get_Description(site, defect2) DEFECT2_DESC,
        C_Defect_API.Get_Description(site, defect3) DEFECT3_DESC,
        C_Defect_API.Get_Description(site, defect4) DEFECT4_DESC

      FROM ifsapp.c_tire_manuf_proc_ovw
      WHERE created_date >= TRUNC(SYSDATE)
        AND GRADE = 'C2'
      ORDER BY created_date ASC
    `;

    const result = await connection.execute(
      sqlText,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return result.rows || [];
  } catch (err) {
    console.error("Query error:", err);
    return [];
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error("Failed to close Oracle connection:", closeErr);
      }
    }
  }
}

// =========================
// MAIN LOOP
// =========================

async function checkAndSendAlerts() {
  if (isCheckingAlerts) {
    console.log("Previous alert cycle still running. Skipping this interval.");
    return;
  }

  isCheckingAlerts = true;

  try {
    await ensureWhatsAppReady();

    const rows = await loadNewAlertRows();

    if (!rows.length) {
      console.log("No C2 records.");
      return;
    }

    for (const row of rows) {
      const rowKey = buildRowKey(row);

      if (sentKeys.has(rowKey)) {
        continue;
      }

      const message = buildMessage(row);

      await sendToGroup(message);

      sentKeys.add(rowKey);
      console.log("Alert sent:", row.BARCODE_ID);
    }
  } catch (err) {
    console.error("Alert error:", err);
  } finally {
    isCheckingAlerts = false;
  }
}

function startMonitoring() {
  if (monitorInterval) {
    console.log("Monitoring already started.");
    return;
  }

  console.log("Monitoring started...");

  // Run once immediately
  checkAndSendAlerts().catch(err => {
    console.error("Initial monitoring error:", err);
  });

  // Then keep polling
  monitorInterval = setInterval(() => {
    checkAndSendAlerts().catch(err => {
      console.error("Scheduled monitoring error:", err);
    });
  }, CHECK_INTERVAL_MS);
}

// =========================
// START
// =========================

client.initialize();