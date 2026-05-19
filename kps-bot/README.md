# kps-bot

Discord KPS battle royale bot prepared for Railway deployment.

## Environment variables

Create a `.env` file for local development:

```env
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
DATABASE_PATH=./data/leaderboard.db
PORT=3000
```

Railway requires at minimum:

- `TOKEN`
- `CLIENT_ID`

Optional variables:

- `DATABASE_PATH`
- `PORT`

If `DATABASE_PATH` is not set, the bot uses:

- `RAILWAY_VOLUME_MOUNT_PATH/leaderboard.db` when a Railway volume is attached
- `./data/leaderboard.db` otherwise

## Local run

```bash
npm install
npm run build
npm start
```

Health endpoint:

- `GET /health`

## Railway deployment

1. Push this repository to GitHub.
2. In Railway, create a new service from the GitHub repository.
3. Set the service Root Directory to `/kps-bot`.
4. In Service Settings, set the Config as Code path to `/kps-bot/railway.json`.
5. Add service variables:
   - `TOKEN`
   - `CLIENT_ID`
6. Add a persistent Volume and mount it to `/app/data`.
7. Deploy the service.

Notes:

- This bot does not need a public domain.
- The healthcheck path is `/health`.
- SQLite data persists only if you attach a Railway volume.

## Railway checks

After deploy, verify:

- Deployment status becomes healthy
- Logs show `Logged in as ...`
- Logs show the database path in use
