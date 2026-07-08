import AdmZip from "adm-zip";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/scan-ppt-placeholders.mjs <pptx-file>");
  process.exit(1);
}

const zip = new AdmZip(file);
const pattern = /OfficePLUS|CONTENT|LOGO|输入标题|请在此输入|请您单击此处输入文本内容加以解释说明|20XX|时间：202X\/05\/01/i;
const hits = [];

for (const entry of zip.getEntries()) {
  if (!/^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName)) continue;
  const xml = entry.getData().toString("utf8");
  if (pattern.test(xml)) hits.push(entry.entryName);
}

console.log(JSON.stringify({ file, hitCount: hits.length, hits }, null, 2));
