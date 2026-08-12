# Deploy Brain Buzz online

## 1. GitHub

Push this repository (including the `public/` folder with Brain Buzz assets) to
GitHub. The service entrypoint is `server.js` via `npm start`.

## 2. Render

1. In Render, click **New → Web Service**.
2. Connect the Brain Buzz GitHub repository.
3. Use:
   - Runtime: Node
   - Build command: `npm install` (no dependencies today; keeps the platform happy)
   - Start command: `npm start`
   - Health check path: `/healthz`
   - Instance type: Free (or higher)
4. Create the service and wait for it to deploy.

You can also use the included `render.yaml` blueprint, which already points the
health check at `/healthz`.

## Notes

- The live app is **Brain Buzz**. Top 100 posts are available through the Brain
  Buzz UI and `/api/top-posts`.
- Static files are read from disk under `public/`.
- No API keys are required for the public endpoints this app uses.
