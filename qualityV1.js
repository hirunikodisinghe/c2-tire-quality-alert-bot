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
const CHECK_INTERVAL_MS = 60 * 1000;
const GROUP_NAME = "ST3 C1 C2 tires";
const SECOND_GROUP_NAME = "GRI ST3 MANUFACTURING";
const SEND_TO_SECOND_GROUP = false;
const GRADE_COLUMN = "GRADE";
 
// In-memory duplicate protection only
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
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check"
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
 
client.on("ready", async () => {
  console.log("WhatsApp Web is ready.");
  await testOracleConnection();
  startMonitoring();
});
 
client.on("auth_failure", (msg) => {
  console.error("WhatsApp auth failure:", msg);
});
 
client.on("disconnected", (reason) => {
  console.error("WhatsApp disconnected:", reason);
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
  return [
    row.BARCODE_ID ?? "",
    row.CREATED_DATE ? formatValue(row.CREATED_DATE) : "",
    row.GRADE ?? ""
  ].join("|");
}
 
function buildMessage(row) {
  return (
`🚨 *Tire Quality Alert*

📦 *Order Details*
🔹 Order No : ${formatValue(row.ORDER_NO)}
🔹 Serial No : ${formatValue(row.SERIAL_NO)}
🔹 Barcode : ${formatValue(row.BARCODE_ID)}

🏭 *Production Info*
🔹 Part No : ${formatValue(row.PART_NO)}
🔹 Description : ${formatValue(row.PART_DESCRIPTION)}
🔹 Shift Time : ${formatValue(row.SHIFT_TIME_ID)}
🔹 Employee : ${formatValue(row.EMP_NO1)}

⚠️ *Defect Information*
🔹 Defect Type : ${formatValue(row.DEFECT_TYPE)}
🔹 Curing Press : ${formatValue(row.PRESS_NO)}

🕒 *Record Info*
🔹 Created Date : ${formatValue(row.CREATED_DATE)}
🔹 Created By : ${formatValue(row.CREATED_BY)}`
  );
}
async function sendToGroup(groupName, message) {
  const chats = await client.getChats();
  const group = chats.find((c) => c.isGroup && c.name === groupName);
 
  if (!group) {
    throw new Error(`Group not found: ${groupName}`);
  }
 
  await group.sendMessage(message);
  console.log(`Sent to group: ${groupName}`);
}
 
// =========================
// ORACLE FUNCTIONS
// =========================
async function testOracleConnection() {
  let connection;
  try {
    connection = await oracledb.getConnection(oracleConfig);
 
    const result = await connection.execute(
      `SELECT COUNT(*) AS CNT
       FROM ifsapp.c_tire_manuf_proc_ovw
       WHERE created_date >= TRUNC(SYSDATE)`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
 
    console.log("Oracle connection successful.");
    console.log("Today rows:", result.rows[0].CNT);
  } catch (err) {
    console.error("Oracle connection failed:", err.message);
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {}
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
        ${GRADE_COLUMN} AS GRADE,
        DEFECT_TYPE,
        PRESS_NO
      FROM ifsapp.c_tire_manuf_proc_ovw
      WHERE created_date >= TRUNC(SYSDATE)
        AND ${GRADE_COLUMN} IN ('C2')
      ORDER BY created_date ASC
    `;
 
    const result = await connection.execute(
      sqlText,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
 
    return result.rows || [];
  } catch (err) {
    console.error("Query failed:", err.message);
    return [];
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {}
    }
  }
}
 
// =========================
// MAIN LOGIC
// =========================
async function checkAndSendAlerts() {
  try {
    console.log("Checking Oracle for new C1/C2 rows...");
 
    const rows = await loadNewAlertRows();
 
    if (!rows.length) {
      console.log("No C1/C2 rows found.");
      return;
    }
 
    for (const row of rows) {
          const normalizedRow = {
          ORDER_NO: row.ORDER_NO,
          SERIAL_NO: row.SERIAL_NO,
          SHIFT_TIME_ID: row.SHIFT_TIME_ID,
          EMP_NO1: row.EMP_NO1,
          BARCODE_ID: row.BARCODE_ID,
          PART_NO: row.PART_NO,
          PART_DESCRIPTION: row.PART_DESCRIPTION,
          GRADE: row.GRADE,
          CREATED_DATE: row.CREATED_DATE,
          CREATED_BY: row.CREATED_BY,
          DEFECT_TYPE:row.DEFECT_TYPE,
          PRESS_NO:row.PRESS_NO
        };
 
      const rowKey = buildRowKey(normalizedRow);
 
      if (sentKeys.has(rowKey)) {
        continue;
      }
 
      const message = buildMessage(normalizedRow);
 
      await sendToGroup(GROUP_NAME, message);
 
      if (SEND_TO_SECOND_GROUP) {
        await sendToGroup(SECOND_GROUP_NAME, message);
      }
 
      sentKeys.add(rowKey);
      console.log("Alert sent for:", rowKey);
    }
  } catch (err) {
    console.error("Alert check failed:", err.message);
  }
}
 
function startMonitoring() {
  console.log(`Monitoring started. Interval: ${CHECK_INTERVAL_MS / 1000} seconds`);
 
  checkAndSendAlerts().catch(console.error);
 
  setInterval(() => {
    checkAndSendAlerts().catch(console.error);
  }, CHECK_INTERVAL_MS);
}
 
client.initialize();