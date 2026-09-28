# WhatsApp daily-digest delivery — PARKED (reverted, kept for future)

Status: **abandoned / reverted as of 2026-09-19.** All code changes were `git
checkout`'d away (the digest worker, `.env.example`, and the one-off
`scripts/setup-whatsapp.mjs` setup script are gone). This file is the full
playbook so the work can be picked up again without rediscovering Meta's API.
The Meta side of the setup (app, test number, registration) is **still alive** —
only our code was removed.

## What was tried, in one line

Send the finished daily digest as a WhatsApp message right after
`scripts/digest-worker.mjs` (the box-side worker, systemd
`bleep-digest-worker.service`) writes it to the DB via `upsertDigestSummary()`.

### Why it was parked

- The **sandbox test number** can only message up to 5 **whitelisted recipients**
  (added + OTP-verified in the API Setup panel). Delivery to the real number
  needs this one manual browser step.
- Business-initiated messages **outside the 24h customer-service window MUST be
  an approved template** (`{{1}}` body param). A scheduled daily digest will
  essentially always be outside the window — so templates are mandatory, not
  optional, and template review is manual.
- No official Meta CLI or device-code login exists; several steps are UI-only
  (recipient whitelist, template creation, system-user token). Not worth it for
  a single-user test setup right now.

## Resources already configured on Meta's side (reusable)

| Resource | Value |
|---|---|
| App name / ID | **Bleep AI** / `1625203858952552` (owner: Shivam Chandan, user id `122095276353488675`) |
| WhatsApp Business Account (WABA) ID | `1505862484921527` |
| Test phone number | `+1 555-190-9701` |
| Phone number ID | `1373080759216026` |
| Test number two-step PIN | `450735` (set via `/register`; required for Cloud API) |
| Related-but-unrelated infra | WABA discovered via `debug_token` granular scopes → `target_ids` |

Security note: the app secret and a temporary token were shared in chat during
setup. The temp token expired within ~24h; the app secret (`d8fb…`) is
unaffected by expiry — **rotate it** in App settings if it was seen by anyone
else.

## The working pattern (recreate later)

All of this worked and was verified against `graph.facebook.com/v23.0`.

### 1. Discovery — find WABA + phone number ID from a token

A user/temporary token's `debug_token` shows its WhatsApp granular scopes:

```
GET /debug_token?input_token=<TOKEN>&access_token=<APP_ID>|<APP_SECRET>
# …scopes: ["whatsapp_business_management","whatsapp_business_messaging"]
# granular_scopes[].target_ids = WABA ID
```

Then:
```
GET /<WABA_ID>/phone_numbers?fields=id,display_phone_number,verified_name
```

The temporary token from App → WhatsApp → API Setup (a long `EAAG…` string,
auto-granted both WhatsApp scopes, valid ~24h) is the key that unlocks all of
this.

### 2. Register the number (once; error `#133010 Account not registered` otherwise)

```
POST /<PHONE_NUMBER_ID>/register
{ "messaging_product": "whatsapp", "pin": "<6-digit 2FA pin>" }   # -> {"success":true}
```

### 3. Long-lived token (temporary user tokens expire in ~24h)

```
GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>
    &client_secret=<APP_SECRET>&fb_exchange_token=<TEMP_TOKEN>
# -> {"access_token": "<EAAG… ~60d>", "expires_in": 5184000}
```

For a **permanent** token (survives restarts, survives the 60 days): create a
**System User** in Business Settings (`business.facebook.com/settings/people` →
System users) with permissions `whatsapp_business_messaging` +
`whatsapp_business_management` and paste that token instead. UI-only step.

### 4. Send

Business-initiated (outside 24h window) — **must** be a template with `{{1}}`:

```
POST /<PHONE_NUMBER_ID>/messages
{ "messaging_product":"whatsapp", "recipient_type":"individual", "to":"<E.164>",
  "type":"template",
  "template": { "name":"<approved_template>", "language":{"code":"en_US"},
    "components":[{"type":"body","parameters":[{"type":"text","text":"<digest text>"}]}] } }
```

Inside a 24h window / test number (plain text) works for a quick smoke test:
`"type":"text"`, `"text": {"preview_url":false, "body":"…"}`.

Hard limits: payload **≤ 4096 chars**; sandbox recipient allowlist **≤ 5
numbers**.

### 5. The code that was wired in (and removed)

After `await upsertDigestSummary(db, run.user_id, run.day, content)` in
`processRun()`, a best-effort, non-fatal send:

```js
try { await sendWhatsApp(run.day, content); }
catch (err) { log(`whatsapp delivery failed (digest still saved): ${err.message}`); }
```

- `sendWhatsApp` -> `fetch(GRAPH_BASE/PHONE_NUMBER_ID/messages)` with the payload
  above, `Authorization: Bearer WHATSAPP_ACCESS_TOKEN`. Non-fatal on failure —
  the digest is already persisted.
- Env vars: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_TO_PHONE` (+ optional `WHATSAPP_TEMPLATE_NAME`,
  `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_TEXT_CAP`, `WHATSAPP_GRAPH_VERSION`).
- The one-off `scripts/setup-whatsapp.mjs` did: validate token against phone id →
  exchange to ~60d token → register if `#133010` → test send → append `WHATSAPP_*`
  to `.env.local`. Recreate it from steps 1–4 above.
- Restart after wiring: `sudo systemctl restart bleep-digest-worker`.

## Error codes hit (quick-reference)

| Code | Meaning | Fix |
|---|---|---|
| `#133010` | Account not registered | `POST /{phone-id}/register` with 6-digit pin |
| `#131030` | Recipient not in allowed list | Add recipient in API Setup (To field → OTP on their phone) |
| `#131047` | Outside 24h customer-service window | Must use an approved template, not text |
| `#131026` | Recipient not an active WhatsApp user | Verify number |

## Facts worth remembering

- App **does not need to be published / App Review** for the test number +
  whitelisted recipients. Publishing (and business verification) is only for a
  **real business phone number** / production at scale.
- There is **no official Meta CLI and no device-code (`gh auth login`-style)**
  flow for the Cloud API. Access is granted in the browser; everything
  API-backed can then be driven with `curl`/`fetch`.
- The "Business" prompt Meta shows during setup is just the **Business Portfolio
  association** step — free and instant, NOT business verification/KYC. Only
  adding a real number triggers actual business verification.
- `debug_token` on an app token returns `type: APP, scopes: []`; app tokens
  cannot reach any WhatsApp endpoint. You need a user (`EAAG…`) or system-user
  token.

## Revisit checklist (when picking this back up)

1. Rotate app secret if it leaked (App settings → Basic).
2. `App → WhatsApp → API Setup`: grab a fresh temporary `EAAG…` token.
3. Discover WABA/phone id via `debug_token`/`phone_numbers` (values above still
   valid).
4. Whitelist the recipient (`To` field → confirm OTP on the phone).
5. Create + get APPROVED an `en_US` template with a `{{1}}` body placeholder.
6. Create a **system-user** permanent token in Business Settings.
7. Rebuild `sendWhatsApp` + hook into `processRun` (full pattern above), set
   `WHATSAPP_TEMPLATE_NAME`, restart the worker.