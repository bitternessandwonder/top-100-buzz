# Top 100 Buzz

Top 100 Buzz is a read-only public feed of posts written by the 100 highest-Level
6529 members.

## Ranking rule

1. Request the 6529 top-community-members list.
2. Read each member's profile Level.
3. Sort Level from highest to lowest.
4. Keep exactly the first 100 unique members.
5. Scan recent public V2 drops and keep posts whose author matches one of those
   members.

Ties retain the ordering returned by the 6529 API.

## Run on a Mac

1. Unzip the folder.
2. Double-click `START-MAC.command`.
3. Keep Terminal open.
4. Visit `http://localhost:3000`.

## Put it online

Create a new GitHub repository named `top-100-buzz`.

Upload **everything inside this folder**, including the complete blue `public`
folder. On the GitHub repository's main page you should see:

- `public/`
- `server.js`
- `package.json`
- `render.yaml`

Then create a new Render Web Service connected to that repository:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Instance type: Free

## Important limits

- This version only reads public data.
- Private or gated Wave posts are not included.
- The site scans blocks of recent drop pages. “Scan older posts” searches the
  next block.
- The ranking is cached for 10 minutes and posts for 30 seconds to reduce API
  traffic.
- The code accepts several plausible sorting query variants because APIs can
  change parameter casing. It then verifies the order itself by sorting the
  returned member levels descending.
