# cosense-grass Privacy Policy

## About this service

cosense-grass is a tool that visualizes your activity on Cosense (formerly Scrapbox).
**It is not an official Cosense service.** It is a personal project and is not affiliated with Helpfeel Inc., the operator of Cosense.
The source code and design are public on [GitHub](https://github.com/shinyaoguri/cosense-contribution-graph).

## What we store

| Item | Form | Purpose |
|---|---|---|
| User identifier | The `sub` of your Google account, HMAC-ed with a server-side secret | To tell whose records they are |
| Device public keys | The public key itself | To verify that records are sent by you |
| One-time codes for device registration | A hash of the code, not the code itself | To register the key of a device you signed in on |
| Project identifiers | Hashes salted with the user identifier above | To count activity per project |
| Daily activity | Per-minute bitmaps and daily totals (minutes written and minutes read; of the minutes written, minutes on pages you newly created and on pages created by others; pages edited; pages newly created; links created) | To draw the graph and the activity overview |
| Time zone | A string such as `Asia/Tokyo` | To decide where a day begins and ends |

## What we do not store

- **Your email address, name, or profile picture.** The only information we receive from Google is `sub` (the account
  identifier). We do not store even that; we keep only the result of HMAC-ing it with a server-side secret
- **Project names.** Only hashes are sent, so the server does not know the names
- **Your Cosense username.** We receive it when drawing an image for a share URL, but do not store it (see "What is shared" below)
- **Page titles or contents.** What you wrote or read is never sent
- **Which pages you read.** Reading records contain only "which minutes you were active",
  and never any page identifier
- **Authors of the pages you wrote on, or link targets.** Whether a page you wrote on was newly created by you or created by someone else is decided inside your browser;
  only minutes and the number of links are sent
- **Private keys.** They stay inside each device's browser and are never sent

## How we handle Google user data

Google Sign-In is used **to merge records from multiple devices (computers or browsers) into one graph for the same user.**
Signing in is needed only the first time and when you add a device. After that, records are authenticated by signatures made with each device's key.

- **What we access:** We request the `openid` scope only and receive only the account identifier (`sub`).
  We do not access your email address, name, or profile picture
- **How we use it:** We derive the user identifier from `sub` with HMAC and a server-side secret, and merge devices of the same Google account into one user's records.
  We do not use it for any other purpose (advertising, profiling, machine learning, and so on)
- **Sharing:** We do not share or transfer it to any third party. We do not sell it
- **Protection:** All traffic uses HTTPS. We never store `sub` itself or the Google ID token; they are discarded right after identity verification.
  Only the irreversible HMAC result is stored. The code shown on screen after sign-in expires in 5 minutes and can be used only once
- **Retention and deletion:** The user identifier is kept until you delete it in "Deleting your data" below. Deleting it removes all records and
  device keys tied to the identifier

Our use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Cookies

During authentication, we use one short-lived cookie to prevent forgery (`__Host-grass-auth`, valid for 10 minutes).
It contains only a random value and the time it was issued, not the user identifier. It is deleted when you come back from sign-in, whether sign-in succeeded or failed.

When sign-in succeeds, we issue **a cookie for viewing your registered devices, valid for 30 minutes only**
(`__Host-grass-session`). It contains the user identifier and the time it was issued, and is signed.
JavaScript cannot read it (HttpOnly), and it is not sent on navigation from other sites (SameSite=Lax).
It is used only on the device list and revocation page, and never for recording activity.
We do not use cookies for tracking.

## Logs

Server logs record aggregate values only. **The user identifier is never written to logs.**
What we record are statistics such as approximate write volume, authentication failure rates, and error rates.

## Retention

| Data | Retention |
|---|---|
| Per-minute bitmaps | 90 days |
| Daily totals | **Not deleted** |
| Device public keys | Until you revoke the device or delete your data |
| Hashes of device registration codes | Until used (up to 5 minutes; if unused, deleted by the next scheduled job) |

Daily totals are **kept indefinitely so that you can look back on them years later.**
You can delete them at any time from the settings when you no longer need them.

Per-minute bitmaps are working data used to merge correctly when the same record arrives more than once.
They are deleted after 90 days, but the graph does not change because the daily totals remain.

## What is shared

Others can see your activity graph **only when you give a share URL to someone.**
Share URLs are derived one-way from the user identifier, and third parties cannot guess or compute them.

A share URL for the graph shows only the daily total (and a color indicating whether you wrote or read more).
**From the graph URL, the activity overview image for the same period (the ratio of creating new pages, growing your pages, engaging with others' pages, and reading) can also be opened.**
It shows only ratios over the whole period, never daily values.

**The URL for daily numbers (JSON) is separate from the graph URL.** The management page shows the one for your combined total, and the graph dialog opened in Cosense shows the ones for your combined total and for each project.
Anyone you give this URL to can see **daily minutes written, minutes read, pages edited, pages newly created,
minutes written on pages you newly created and on pages created by others, and links created.** This URL cannot be derived from the graph URL, so you can choose separately whether to show the numbers to people you showed the graph to.
This URL is also derived one-way from the user identifier, and third parties cannot guess or compute it.
We instruct search engines not to index it.

**Per-project share URLs contain the project name.** To show which project a graph belongs to,
the name is also drawn in the image. The server does not store this name; it receives the name only to
draw the image. **If you do not want to show the name, remove `?l=...` from the end of the URL before sharing it**
(the graph is then shown without a name). The share URL for the total across all projects does not contain project names.

**Share URLs also contain your Cosense username** (both the total and per-project ones). To show whose graph it is,
`@<username>` is drawn in the image. As with project names, the server does not store this name;
it receives the name only to draw the image. **If you do not want to show it, remove `u=...`
from the URL.**

## Disclosure to third parties

We do not disclose data to third parties. We use no advertising and no analytics services.

We use Cloudflare (Workers and D1) as infrastructure and Google's OpenID Connect for
authentication. Data is not passed to anyone else.

## Deleting your data

**Data on the server** can be deleted entirely from the management page (`https://grass.soui.dev/account`).
After signing in with Google, you can list your registered devices, see your share URLs, and delete your data.
Deletion removes all daily totals, bitmaps, share URLs, and registered device keys,
and the graph and daily numbers at your share URLs can no longer be viewed. You can also revoke individual devices on the same page.

**Records left in your browser** can be deleted from the Cosense page menu "cosense-grass" → "設定" (Settings).
They exist only inside your browser, so the server cannot delete them. On the same screen, you can also unregister just that device.

## Accuracy of the numbers

Recorded activity is **self-reported by your browser**, and the server has no way to verify it.
**It cannot serve as a basis for evaluation or comparison.**

## Disclaimer

This is a personal project provided free of charge. We do not guarantee availability or data preservation.
On days when the server reaches the limit of its free tier, records are not accepted and are resent the next day.

## Contact

Please contact us through
[GitHub Issues](https://github.com/shinyaoguri/cosense-contribution-graph/issues).

## Changes

Changes to this policy are recorded in the history of the GitHub repository.
Significant changes are announced in the repository.
