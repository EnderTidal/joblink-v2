// Fix: add "mobile phone" to phone header aliases in importing.js
const fs = require('fs');
const path = '/root/joblink-v2/src/importing.js';
let code = fs.readFileSync(path, 'utf8');

if (code.includes("'mobile phone'")) {
  console.log('Already patched — skipping');
  process.exit(0);
}

// Add "mobile phone" to the phone aliases
code = code.replace(
  "phone: ['phone', 'phone number', 'phone#', 'cell', 'cell phone', 'mobile', 'number', 'text number', 'telephone'],",
  "phone: ['phone', 'phone number', 'phone#', 'cell', 'cell phone', 'mobile', 'mobile phone', 'mobile number', 'cell number', 'number', 'text number', 'telephone', 'home phone', 'work phone'],"
);

fs.writeFileSync(path, code);
console.log('Patched importing.js: added "mobile phone" + 3 more aliases to phone header detection');
