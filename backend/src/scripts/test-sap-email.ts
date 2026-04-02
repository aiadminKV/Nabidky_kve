import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import "dotenv/config";

const host = process.env.SAP_SMTP_HOST!;
const user = process.env.SAP_MAIL_FROM!;
const pass = process.env.SAP_MAIL_PASSWORD!;
const to = process.env.SAP_MAIL_TO ?? "faktury@kvelektro.cz";

console.log(`\nTest odeslání SAP emailu`);
console.log(`  SMTP:  ${host}`);
console.log(`  From:  ${user}`);
console.log(`  To:    ${to}`);
console.log();

const transporter = nodemailer.createTransport({
  host,
  port: 587,
  secure: false,
  auth: { user, pass },
});

try {
  await transporter.verify();
  console.log("✓ SMTP spojení OK");
} catch (err) {
  console.error("✗ SMTP verify failed:", err);
  process.exit(1);
}

// Generate test XLSX
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("SAP");

const headers = ["ID", "IC", "Nazev", "termin_dodani", "Nazev_zakazky_cislo", "tel", "email", "spec_akce", "pobocka", "adresa_dodani", "ARTICLES", "ARTIKL", "PRODID", "POPIS", "MNOZSTVI", "MJ"];
const headerRow = sheet.addRow(headers);
headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } };

sheet.addRow(["CUST001", "12345678", "Test s.r.o.", "2026-04-30", "TEST-nabidka", "+420 123 456 789", "test@test.cz", "", "Praha", "Testovací 1, Praha", 2, "SKU001", "PROD001", "Testovací produkt 1", 5, "ks"]);
sheet.addRow(["", "", "", "", "", "", "", "", "", "", "", "SKU002", "PROD002", "Testovací produkt 2", 10, "m"]);

const xlsxBuffer = await workbook.xlsx.writeBuffer();
const filename = `kv-sap-test-${Date.now()}.xlsx`;

try {
  const info = await transporter.sendMail({
      from: `"Data Bridge Pro" <${user}>`,
    to,
    subject: "offer_data_bridge TEST-nabidka",
    text: [
        `Nabídka pro SAP: TEST-nabidka`,
        ``,
        `Zákazník:       Test s.r.o.`,
        `IČO:            12345678`,
        `Termín dodání:  2026-04-30`,
        `Počet položek:  2`,
        ``,
        `Soubor je přiložen jako příloha.`,
      ].join("\n"),
    attachments: [
      {
        filename,
        content: Buffer.from(xlsxBuffer as ArrayBuffer),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  });

  console.log("✓ Email odeslán — messageId:", info.messageId);
} catch (err) {
  console.error("✗ Odeslání selhalo:", err);
  process.exit(1);
}
