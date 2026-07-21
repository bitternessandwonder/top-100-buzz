# Publish Top 100 Buzz

You already used this process for the first feed.

## 1. GitHub

1. Make a new public repository called `top-100-buzz`.
2. Click **Add file → Upload files**.
3. Open this unzipped folder in Finder.
4. Select everything *inside* the folder and drag it to GitHub.
5. Confirm the blue `public` folder appears in the upload.
6. Click **Commit changes**.

## 2. Render

1. In Render, click **New → Web Service**.
2. Connect the new `top-100-buzz` GitHub repository.
3. Use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
4. Create the service and wait for it to deploy.

Do not overwrite your original Brain Buzz repository unless you intentionally
want this new site to replace it.
