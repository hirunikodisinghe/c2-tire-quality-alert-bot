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
  // example: "172.20.10.15:1521/ORCL"
};
 
// =========================
// SETTINGS
// =========================
const CHECK_INTERVAL_MS = 60 * 1000; // every 1 minute
const SEND_TO_GROUP = true;
const GROUP_NAME = "ST3 Management Group";
 
// Optional: also send to another group
const SECOND_GROUP_NAME = "GRI ST3 MANUFACTURING";
const SEND_TO_SECOND_GROUP = false;
 
// Change this if your actual grade column name is different
const GRADE_COLUMN = "GRADE";
 
// Keep already-sent alerts only in memory while program is running
const sentKeys = new Set();
 
// =========================
// WHATSAPP CLIENT
// =========================
const client = new Client({
  authStrategy: new LocalAuth()
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
    `🚨 Tire Quality Alert\n` +
    `Barcode ID: ${formatValue(row.BARCODE_ID)}\n` +
    `Grade: ${formatValue(row.GRADE)}\n` +
    `Created Date: ${formatValue(row.CREATED_DATE)}`
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
      } catch (_) {}
    }
  }
}
 
async function loadNewAlertRows() {
  let connection;
  try {
    connection = await oracledb.getConnection(oracleConfig);
 
    const sql = `
      SELECT
        barcode_id,
        created_date,
        ${GRADE_COLUMN} AS grade
      FROM ifsapp.c_tire_manuf_proc_ovw
      WHERE created_date >= TRUNC(SYSDATE)
        AND ${GRADE_COLUMN} IN ('C1', 'C2')
      ORDER BY created_date ASC
    `;
 
    const result = await connection.execute(
      sql,
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
      } catch (_) {}
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
        BARCODE_ID: row.BARCODE_ID,
        CREATED_DATE: row.CREATED_DATE,
        GRADE: row.GRADE
      };
 
      const rowKey = buildRowKey(normalizedRow);
 
      if (sentKeys.has(rowKey)) {
        continue;
      }
 
      const message = buildMessage(normalizedRow);
 
      if (SEND_TO_GROUP) {
        await sendToGroup(GROUP_NAME, message);
      }
 
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
 
// =========================
// START
// =========================
client.initialize();