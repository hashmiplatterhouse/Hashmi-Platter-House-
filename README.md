# Hashmi Platter House — Software Setup

This is the clean upload-ready project structure:

- `public/` — website frontend and image assets
- `server.js` — Express backend + API
- `package.json` — dependencies/start command
- `.env.example` — private server settings template

## GitHub upload
Upload the CONTENTS of this folder into the root of your GitHub repository, so `package.json`, `server.js`, and `public/` are visible at the repository root.

## Render
Create a Web Service from the GitHub repository.
Build Command: `npm install`
Start Command: `npm start`

Then add environment variables from `.env.example`.

Do not upload `.env`, passwords, API tokens, or payment credentials.

## Important
The backend foundation is ready, but the existing frontend's demo/local-storage controls still need to be wired to these `/api/*` endpoints before claiming the entire site is production-connected. That final integration should be tested on the deployed server.
