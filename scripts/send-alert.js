// Shared alert email sender via Resend
// Usage: node scripts/send-alert.js "Subject" "Body text"
const https = require('https');

const RESEND_KEY = 're_ePrkKNY8_GXbFGuPkRLdSzE4DY8DC7Wi1';
const FROM = 'JobLink <resume@thetelosway.com>';
const TO = 'joshuafriends@gmail.com';

function sendAlert(subject, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      from: FROM,
      to: [TO],
      subject: `[JobLink V2] ${subject}`,
      text: body,
    });
    const req = https.request({
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(chunks);
        } else {
          reject(new Error(`Resend ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// CLI mode
if (require.main === module) {
  const subject = process.argv[2] || 'Alert';
  const body = process.argv[3] || 'No details provided.';
  sendAlert(subject, body)
    .then(() => console.log('Alert sent'))
    .catch((e) => console.error('Alert failed:', e.message));
}

module.exports = { sendAlert };
