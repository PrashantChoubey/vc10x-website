# VC10X website

vc10x.com: homepage, the Family Gap Audit and the Fundraising Readiness Audit.
Static HTML with three small Cloudflare Pages Functions. No build step.

```
index.html                    homepage
audit/                        Family Gap Audit      -> vc10x.com/audit/
fundraising-audit/            Fundraising Audit     -> vc10x.com/fundraising-audit/
functions/api/subscribe.js    newsletter + audit signups -> beehiiv
functions/api/issues.js       "Latest from the newsletter" feed from beehiiv
functions/api/popular.js      titles for the Popular conversations videos (YouTube)
_redirects, _headers          Cloudflare Pages routing and headers
wrangler.toml                 Cloudflare Pages config
```

## 1. beehiiv setup (free Launch plan works)
1. Settings > API: create an API key. Copy it and your Publication ID (starts with `pub_`).
2. Audience > Custom fields: create five text fields, spelled exactly:
   `First Name`, `Role`, `Audit Score`, `Audit Tier`, `Weakest Pillar`
3. Optional: write a welcome email in beehiiv. New signups receive it.

Every signup is tagged with where it came from (UTM campaign): `home-hero`,
`home-newsletter`, `family-gap-audit` or `fundraising-audit`, unless the visitor
arrived on a link that already carried UTM tags.

## 2. Deploy on Cloudflare Pages
1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git.
2. Pick this repository. No framework preset, no build command.
   The output directory is set in `wrangler.toml` (the repo root).
3. Settings > Variables and Secrets, for Production:
   - `BEEHIIV_API_KEY` (type: Secret)
   - `BEEHIIV_PUBLICATION_ID`
4. Redeploy once after adding the variables.
5. Test on the `*.pages.dev` address: subscribe from the homepage, take both
   audits, and confirm the signups land in beehiiv.

Every push to `main` redeploys automatically.

## 3. Point vc10x.com at it
1. Pages project > Custom domains > Set up a custom domain: `vc10x.com`, then `www.vc10x.com`.
2. If vc10x.com's DNS is already on Cloudflare, it's connected in a click.
   If not, add the domain to Cloudflare and switch your registrar's nameservers
   to the two Cloudflare gives you.
3. Before switching, copy any email records (MX, TXT/SPF, DKIM) from your
   current DNS provider into Cloudflare, or @vc10x.com email will stop working.
4. Add redirects for pages on the old site that people link to, in `_redirects`.

## Editing content
- Popular conversations: the `POPULAR` list near the bottom of `index.html`. One YouTube
  link per line, in display order; the first is featured. Thumbnails and titles
  come from YouTube automatically.
- Audit questions, scoring and advice: the `PILLARS`, `QUESTIONS` and `TIERS`
  blocks near the top of each audit's `index.html`.
- Related episodes in audit reports: the `EPISODES` object in each audit.
- Analytics: paste your snippet where each page's `<head>` says "Analytics".

## Local testing
```
cp .dev.vars.example .dev.vars   # add your beehiiv keys
npx wrangler pages dev .
```
Then open http://localhost:8788.
