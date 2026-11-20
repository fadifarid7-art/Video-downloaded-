# Setting up the downloader on Cloudflare (free)

You end up with a private page, `https://video-downloader.<your-name>.workers.dev`, that only you can open.
Paste a link, get the videos and images with download buttons.

Everything below is done in a browser at **dash.cloudflare.com**. Nothing is installed on your phone.

## 1. Create the account
Sign up at dash.cloudflare.com (free plan). Confirm your email.

## 2. Publish the helper from GitHub
1. **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub when asked, and allow access to the **Video-downloaded-** repository.
3. Pick the repository, then set:
   - **Branch**: `claude/awesome-archimedes-u811dj`
   - **Root directory** (under advanced settings): `worker`
   - Project name: `video-downloader`
4. **Deploy**. After a minute you get an address ending in `.workers.dev`.
   Opening it now shows the page, but searching says *"The login lock isn't set up yet"*. That's expected:
   the helper stays switched off until step 3 is done.

## 3. Turn on the login lock
1. Open the new Worker → **Settings** → **Domains & Routes** → on the `workers.dev` row, choose **Enable Cloudflare Access**.
   - The first time, Cloudflare asks you to set up **Zero Trust**: pick a team name and the **Free** plan.
     It may ask for a card to activate the free plan; the free plan isn't charged.
2. Open **Zero Trust** → **Access** → **Applications** → the application for your Worker:
   - **Policies**: make sure the only rule is *Include → Emails → your own email address*.
   - **Overview / Basic information**: copy the **Application Audience (AUD) Tag**.
3. In **Zero Trust** → **Settings**, note your **Team domain**, like `yourteam.cloudflareaccess.com`.
4. Back on the Worker → **Settings** → **Variables and Secrets** → **Add**:
   - `ACCESS_TEAM` = your team domain, e.g. `yourteam.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag you copied
   Save and deploy.

## 4. Use it
1. Open your `workers.dev` address in Aloha (or any browser).
2. Enter your email, then the code Cloudflare emails you.
3. Paste a link → **Find videos and images** → **Download**, or **Download all, one by one**.

## 5. Optional: make the GitHub repo private again
Cloudflare keeps its access to the repo, so new versions still publish when the branch changes.
