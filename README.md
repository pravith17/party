# The Birthday Club

Personal birthday invitations from Pravith and Abhishek, built with HTML, CSS, vanilla JavaScript, Node.js/Express and MongoDB.

## Run locally

Requires Node.js 22 or newer and a reachable MongoDB database.

```sh
npm install
# Copy .env.example to .env and fill in credentials if .env does not exist.
npm start
```

- Guest preview: http://localhost:3000
- Admin: http://localhost:3000/admin
- Individual invitation: http://localhost:3000/guest-name

The provided administrator credentials and database connection are configured in the local, git-ignored `.env`. Never include this file in a public repository. Passwords are hashed in server memory; session cookies are HTTP-only and backed by MongoDB. All admin writes require a CSRF token.

## Make the party yours

1. Sign in at `/admin`.
2. Open **Party settings**. Set the date, time, time zone, venue, exact address, map link, dress code, welcome message, thank-you note, and farewell note.
3. Choose **New invitation**, enter a name, add a profile picture and a description about the person, customize the URL, write a personal message, and paste a YouTube video link.
4. Save the invitation, then upload up to 12 photos in common formats, including HEIC/HEIF. Photos are optimized as WebP and stored in MongoDB GridFS.
5. Copy the invitation link. The guest can view it without signing in. Anyone with that link can view the invitation and submit a response, so share guest links individually. Once attendance is confirmed, the server permanently locks it; a decline cannot overwrite it, even from a different browser or a simultaneous request.
6. View guests, filters, latest responses and response histories in the dashboard. Export responses as CSV when needed.

Changing an invitation’s URL invalidates its previous link. Deleting an invitation deletes its photos and response history.

## Guest experience

- The supplied `Assests/hero-Img.jpg` is served from `public/assets/hero-img.jpg` as the full, uncropped hero on every invitation home page.
- A light-only, mobile-first invitation with the supplied hero image, personal note, simple event details and photo memories on response pages.
- YouTube soundtrack per guest, with background playback, compact play/pause controls and an external fallback for errors. The video is offscreen. Playback is attempted on load; if the browser blocks sound autoplay, the first guest interaction starts it. Guests can also press Play song. The referrer policy includes the origin required by YouTube. Videos that prohibit embedding need the external YouTube link.
- Yes saves an attending RSVP and shows a personalized thank-you with the venue and map.
- No jumps on the first three clicks; the fourth opens the questionnaire. The final decline button repeats the sequence, then saves the decline and shows the farewell page. Guests who declined can change their response to attending. Once attending, the response is permanent.
- Reduced-motion support and a direct option to skip playful buttons are included.
- RSVP history retains the most recent 50 responses per guest.
- `/demo` is a sample invitation: its RSVPs are never saved.

## Deploy to your domain

This app needs a Node.js host and MongoDB connectivity. Production photos are optimized and stored in MongoDB GridFS; local demo mode uses temporary files. It is not a static-only site.

1. Deploy this directory to your Node.js server. Install dependencies with `npm ci --omit=dev`.
2. Set the environment values from `.env.example` on the host. Set `NODE_ENV=production`, a random `SESSION_SECRET`, the administrator credentials, and `PUBLIC_URL=https://your-domain.com`. This URL must match the actual browser origin; it protects writes from cross-site requests.
3. Start `node server.js` behind one trusted reverse proxy with HTTPS. `trust proxy` is set to one hop. Adapt this to your host’s proxy topology.
4. Configure MongoDB Atlas network access for the server. Give the database user access to the `birthday_club` database.
5. Point your domain to the host and verify login, photo uploads and one guest RSVP.

### Photo storage on Vercel

Photos are stored in MongoDB GridFS alongside the app’s existing invitation data. The browser sends each photo to the server in 3 MiB chunks, so the 4.5 MB Vercel Function request-body limit does not block large uploads. The server converts supported images—including iPhone HEIC/HEIF—to optimized WebP and saves the result in GridFS. No separate Vercel Blob store is required. MongoDB GridFS stores files as multiple database documents, which supports images larger than MongoDB’s 16 MiB per-document limit.

Make sure the existing MongoDB Atlas user can read and write in the app database and that Atlas allows connections from the Vercel deployment. Large photo collections use your MongoDB storage quota.

Guest URLs become `https://your-domain.com/custom-guest-name` automatically.

Use `DEMO_MODE=true` only for isolated previews. It uses temporary in-memory data and sessions, not MongoDB; restarting loses the guest list.

## Verification

```sh
npx playwright install chromium
npm test
npm audit --omit=dev
```

Tests use an isolated temporary server on port 3001 with in-memory records. They cover URL/video validation, authentication, CSRF, duplicate slugs, image uploads, party settings, both playful RSVP sequences, saved histories, permanent attendance across reloads and browsers, YouTube controls and mobile overflow. They do not modify the real MongoDB guest list.

Optional WebMCP invitation-read and RSVP tools are feature-detected. Native WebMCP validation was unavailable in the test browser; standard browser flows are covered by the tests.

Guest profiles: the profile picture is separate from the memory gallery, is cropped to a square, and appears with the name and description on the invitation. Replace it by selecting a new picture and saving the invitation. Confirmed guest names appear at the bottom of invitation and thank-you pages; this public list excludes pending/declined guests, private responses, descriptions and invitation URLs.
