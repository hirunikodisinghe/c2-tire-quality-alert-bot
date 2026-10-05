const oracledb = require("oracledb");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// =========================
// ORACLE CONFIG
// =========================
const oracleConfig = {
  user: "",
  password: "",
  connectString: ""
};

// =========================
// SETTINGS
// =========================
const CHECK_INTERVAL_MS = 60000;
const GROUP_NAME = "ST3 C2 tires";

const sentKeys = new Set();

// =========================
// WHATSAPP CLIENT
// =========================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "quality-bot"
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

client.on("ready", async () => {
  console.log("WhatsApp Web is ready.");
  await testOracleConnection();
  startMonitoring();
});

// =========================
// HELPERS
// =========================

function formatValue(value) {
  if (!value) return "";
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
  ].filter(d => d && d.trim() !== "");

  const defectText = defects.length
    ? defects.map(d => `🔹 ${d}`).join("\n")
    : "🔹 No defect description";

  return `🚨 *C2 Tire Quality Alert*

📦 *Order Details*
🔹 Order No : ${row.ORDER_NO}
🔹 Serial No : ${row.SERIAL_NO}
🔹 Barcode : ${row.BARCODE_ID}

🏭 *Production Info*
🔹 Part No : ${row.PART_NO}
🔹 Description : ${row.PART_DESCRIPTION}
🔹 Shift Time : ${row.SHIFT_TIME_ID}
🔹 Employee : ${row.EMP_NO1}

⚠️ *Defects*
${defectText}

🏭 *Curing Press*
🔹 ${row.PRESS_NO}

🕒 *Record Info*
🔹 Created Date : ${formatValue(row.CREATED_DATE)}
🔹 Created By : ${row.CREATED_BY}`;
}

async function sendToGroup(groupName, message) {

  const chats = await client.getChats();
  const group = chats.find(c => c.isGroup && c.name === groupName);

  if (!group) throw new Error(`Group not found: ${groupName}`);

  await group.sendMessage(message);

  console.log("Message sent to:", groupName);
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

  } finally {

    if (connection) await connection.close();

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
      AND GRADE IN ('C2')

      ORDER BY created_date ASC
    `;

    const result = await connection.execute(
      sqlText,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return result.rows;

  } catch (err) {

    console.error("Query error:", err);

    return [];

  } finally {

    if (connection) await connection.close();

  }
}

// =========================
// MAIN LOOP
// =========================

async function checkAndSendAlerts() {

  try {

    const rows = await loadNewAlertRows();

    if (!rows.length) {

      console.log("No C2 records.");

      return;

    }

    for (const row of rows) {

      const rowKey = buildRowKey(row);

      if (sentKeys.has(rowKey)) continue;

      const message = buildMessage(row);

      await sendToGroup(GROUP_NAME, message);

      sentKeys.add(rowKey);

      console.log("Alert sent:", row.BARCODE_ID);

    }

  } catch (err) {

    console.error("Alert error:", err);

  }
}

function startMonitoring() {

  console.log("Monitoring started...");

  checkAndSendAlerts();

  setInterval(checkAndSendAlerts, CHECK_INTERVAL_MS);
}

// =========================

client.initialize();