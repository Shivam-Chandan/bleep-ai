# Zoom transcript integration — design (not yet implemented)

Status: **designed, code stubs in place** (`zoom` is an accepted `/api/ingest` source
and the digest renders a ZOOM section). The fetch + summarize job is NOT built yet.

## Why Zoom is different from Gmail/Calendar/Slack

A 1-hour Zoom transcript is **10,000–40,000 tokens**. The local CPU model runs at
~5 tokens/sec, and both delivery paths have hard timeouts:

- Cloudflare quick tunnel: **100s** cap on any request
- Vercel serverless function: **300s** cap

So a transcript can **never** be summarized inside an HTTP request through the
tunnel or on Vercel. It also must never be fed raw into the daily digest prompt.

## Architecture: two-stage, map-reduce on the Ollama box

```
STAGE 1 — per meeting, runs ON the Linux box (cron/systemd), hits localhost:11434
  1. Mint Zoom Server-to-Server OAuth token (client_credentials grant)
  2. GET /v2/users/me/recordings?from=<yesterday>&to=<today>
  3. For each meeting that has a recording_file of type TRANSCRIPT:
       a. Download the .vtt (localhost = no 50MB/6-min Apps Script limits)
       b. Parse VTT -> plain text (strip "WEBVTT", cue numbers, timestamps)
       c. MAP:   split into ~2k-token chunks; summarize each chunk locally
       d. REDUCE: combine chunk summaries into ONE ~100-word meeting summary
                  focused on decisions, action items, owners, follow-ups
       e. POST that SHORT summary to /api/ingest as source:"zoom"
          (tiny payload — no timeout risk crossing the tunnel)

STAGE 2 — daily digest (existing Vercel cron /api/digest/summarize)
  Reads zoom items alongside gmail/calendar/slack. The digest prompt already
  renders a "## ZOOM" section and a "From yesterday's meetings" briefing section.
```

Key principle: the slow, timeout-prone map-reduce runs **locally with no HTTP cap**.
Only the final ~100-word summary crosses the tunnel.

## Ingest payload shape (source: "zoom")

```json
{
  "source": "zoom",
  "items": [
    {
      "externalId": "<meeting uuid>",
      "day": "2026-09-19",
      "payload": {
        "title": "Cloud Platform Roadmap Ops",
        "summary": "Team agreed to ship v0.1.0 to staging; Shivam to fix the IDE hibernation bug; Q3 vector DB FR needs core-team review by Fri.",
        "actionItems": ["Shivam: fix IDE hibernation", "Review Vector DB FR (ACNPLAT-E-483)"]
      }
    }
  ]
}
```

The digest renderer (`src/lib/digest.ts` -> ZoomPayload) reads `title`, `summary`,
and optional `actionItems`.

## Components to build (later)

| Component | Location | Notes |
|---|---|---|
| Zoom S2S OAuth + recordings fetch | local Node script on Linux box | `client_credentials` token; scope `cloud_recording:read:list_user_recordings` |
| VTT parser | local script | strip WEBVTT header, cue indices, `00:00:00.000 -->` lines |
| Map-reduce summarizer | local script -> `localhost:11434` | chunk ~2k tokens; summarize; then reduce |
| systemd timer | Linux box | run hourly (transcripts appear ~30 min post-meeting) |
| `zoom` source type | done | `db.ts` generic; `queries.ts` DigestSource; `/api/ingest` VALID_SOURCES |
| digest ZOOM section | done | `src/lib/digest.ts` renderSource + section order |

## Provisioning checklist (when building)

1. Zoom Marketplace -> Build App -> **Server-to-Server OAuth**. Note `account_id`,
   `client_id`, `client_secret`.
2. Add scope: `cloud_recording:read:list_user_recordings` (+ any transcript-read
   scope Zoom requires for your account type).
3. In Zoom settings, enable **Cloud recording** and **Audio transcript** (transcripts
   only exist for cloud recordings, not local).
4. Local env (on the Ollama box): `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
   `ZOOM_CLIENT_SECRET`, plus an `INGEST_TOKEN` for the user.

## Open decision (deferred)

Summarization engine for Stage 1 was chosen as **local model, chunked map-reduce**.
This is why Stage 1 must run on the Linux box, not the tunnel/Vercel. If per-meeting
latency (10–20 min/meeting) becomes a problem, revisit using OpenRouter for Stage 1
only (seconds instead of minutes), keeping the local model for the daily digest.
