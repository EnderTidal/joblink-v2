# Customer Update Email Template

Standard format for all JobLink product update emails sent to customers.

## Rules

1. **No technical jargon** — no file names, line counts, test results, or git details
2. **Customer benefit first** — lead with what they can do now, not what we changed
3. **Inline images** — screenshots embedded in the email body, never as attachments
4. **Consistent sender** — `The JobLink Team <notifications@joblinkplatform.com>`
5. **Consistent structure** — header, features (with screenshots), footer
6. **Short** — one scroll max. If more than 3 features, split into multiple emails or link to changelog

## Inline Image Method (Resend API)

Images must use `content_id` (CID) references to display inline in email clients.

```javascript
// Each attachment needs a content_id field
const attachments = [
  {
    filename: 'feature-screenshot.png',
    content: fs.readFileSync('/path/to/screenshot.png').toString('base64'),
    content_id: 'feature-screenshot'  // <-- this is the key
  }
];

// Reference in HTML with cid: prefix
const html = '<img src="cid:feature-screenshot" style="max-width:100%" />';

// Resend API call
fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + RESEND_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    from: 'The JobLink Team <notifications@joblinkplatform.com>',
    to: ['recipient@example.com'],
    subject: 'JobLink Update — Feature Name',
    html: html,
    attachments: attachments
  })
});
```

**Important:** `content_id` must match the `cid:` reference exactly. No file extension in the content_id.

## HTML Template

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a">

  <!-- Header -->
  <div style="background:#4338ca;color:#fff;padding:24px 32px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:22px;font-weight:600">What's New in JobLink</h1>
    <p style="margin:6px 0 0;opacity:0.85;font-size:14px">September 2026</p>
  </div>

  <div style="padding:24px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">

    <!-- Feature 1 -->
    <h2 style="font-size:18px;color:#1e1b4b;margin:0 0 8px">Feature Name</h2>
    <p style="color:#374151;line-height:1.6;margin:0 0 12px">
      One or two sentences explaining what this does and why it matters to the user.
    </p>
    <img src="cid:feature-1" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 24px" />

    <!-- Feature 2 (if applicable) -->
    <h2 style="font-size:18px;color:#1e1b4b;margin:0 0 8px">Feature Name</h2>
    <p style="color:#374151;line-height:1.6;margin:0 0 12px">
      One or two sentences.
    </p>
    <img src="cid:feature-2" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 24px" />

    <!-- Footer -->
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
    <p style="color:#6b7280;font-size:13px;margin:0">
      Questions? Reply to this email.
    </p>
  </div>

</div>
```

## Screenshot Guidelines

- **Crop to the relevant area** — don't send full-page screenshots unless the feature is full-page
- **Light mode preferred** — most email clients have white backgrounds
- **Max width 620px** — the email container is 620px wide
- **PNG format** — for UI screenshots (JPEG for photos)
- **Border + radius** — `border:1px solid #e5e7eb;border-radius:8px` on all images

## Example Subject Lines

- `JobLink Update — Blast Guard Override + Rule Out All`
- `What's New in JobLink — Scheduled Blasts`
- `JobLink Update — Dark Mode + Filter Chips`

Keep subjects under 60 characters when possible. Lead with "JobLink Update" for consistency.

## Sending Rules

1. **Always send separate emails** — one per recipient. Never put multiple customers in the To field (they shouldn't see each other's addresses).
2. **CC Josh and Matt on every customer email** — joshuafriends@gmail.com + matt.tibbetts@expresspros.com
3. **Reply-to should work** — use notifications@joblinkplatform.com as sender, which should forward replies appropriately
4. **Send to admins first** — recruiters get updates from their admin, not from us directly (unless told otherwise)
