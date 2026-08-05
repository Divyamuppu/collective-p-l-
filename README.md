# Collective P&L Dashboard — Simple Starter

One Node.js server. One database file (SQLite — no separate database program to install). No Docker, no build step for the frontend.

## What you need installed

Just **Node.js**. That's it. (You already have it, since you were running `npm` commands earlier.)

## Setup — run these in order, in one terminal

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm start
```

What each line does:
1. `npm install` — downloads Express and Prisma
2. `npx prisma generate` — builds the database client code
3. `npx prisma migrate dev --name init` — creates `dev.db`, a single database file, right in this folder
4. `npm run seed` — fills it with 6 verticals, 12 sample projects, and sample revenue/expenses
5. `npm start` — starts the server

Once you see `P&L dashboard running at http://localhost:3000`, open that link in your browser. You'll land on a **login screen** first.

## Logging in

Three demo accounts are seeded automatically, all with the password `password123`:

| Email | Role | Can delete verticals/projects? |
|---|---|---|
| `admin@company.com` | EXEC | Yes |
| `finance@company.com` | FINANCE | Yes |
| `pm@company.com` | PROJECT_MANAGER | No |

Everyone can view dashboards, add revenue/expenses, create projects and verticals. Only EXEC and FINANCE can delete — this is enforced on the server, not just hidden in the UI, so even a direct API call from a PROJECT_MANAGER's account gets rejected.

## How the numbers work

Only revenue and expense entries are ever saved. Project P&L, vertical P&L, and company P&L are calculated from scratch on every page load by adding those up — nothing is pre-merged, so there's nothing that can go out of sync. `server.js` has all of this logic in one place if you want to look at it.

## If something goes wrong

- **"command not found: npm"** — Node.js isn't installed. Download it from nodejs.org (choose the macOS installer) and try again.
- **Port 3000 already in use** — stop whatever else is using it, or run `PORT=3001 npm start` and open `localhost:3001` instead.
- **"Invalid email or password" even with the demo credentials** — you likely need to re-run the seed step (see below); the database might be from before login was added.
- Any other error — copy the exact terminal output and send it over.

## Updating from an earlier version

The database schema gained new fields (`Vendor` got several new columns) since your last setup, so redo the database setup once:

```bash
rm -f prisma/dev.db
rm -rf prisma/migrations
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm start
```

## Vendors and Users

- **Vendors** (sidebar → Vendors) tracks accounts payable: project, vendor name, service, invoice date, deadline, amount, quarter, POC, approver, last payment, payment timeline, bank details, and an optional invoice attachment. Overdue is always computed live from the deadline and paid flag — never stored, so it can't drift out of sync. There's no separate "Payment Status" field — each row's "⋮" menu has a **Mark Paid / Mark Pending** action that flips it directly.
- **Users** (sidebar → Users, EXEC-only) lets an EXEC create/edit/delete logins and set roles. You can't delete the account you're currently logged in as.

Verticals, Projects/Revenue/Expenses, Vendors, and Users all have full create/read/update/delete, matching the same permission model everywhere: EXEC/FINANCE can delete, everyone logged in can create and edit, and User management specifically is EXEC-only. Each row's Edit/Delete actions live behind a small "⋮" menu button rather than sitting as separate buttons in the row.

(There used to be a separate Clients page for tagging projects with a client. It's been removed — projects are just linked to a vertical now.)

## Vendor Settings (⚙ icon on the Vendors page)

Quarter, POC, Approved by/PM, and Payment Timeline are dropdowns backed by editable lists, not free text. Click the **⚙** icon at the top of the Vendors page to add, rename, or delete entries in each of those four lists. Renaming updates every vendor already using that value; deleting an option never breaks a vendor row that already has it — it just won't be offered for new ones.

You don't have to open Settings just to add one new value, either — every one of those four dropdowns has a **"+ Add new…"** option right in the list itself. Pick it, type the new value, and it's added and selected on the spot without losing anything else you've typed into the form.

## Starting from an empty workspace

If you want to clear out the seeded demo verticals/projects/vendors and start fresh: log in as an EXEC (`admin@company.com`), go to the **Company dashboard**, click the **⚙** icon next to the heading, and use **Clear all workspace data** in the Danger zone. It asks for confirmation twice and can't be undone. Your logins are untouched, so you won't get locked out — you'll just land on a genuinely empty dashboard ready for your own verticals and projects.

## Invoice attachments and auto-fill

On the vendor form, attaching a PDF or image (`Invoice attachment` field) does two things:
1. Saves the file, viewable later from the vendor's row (`View` link, or from the form when editing).
2. Tries to auto-fill **Vendor Name, Service, Invoice Date, Deadline (due date), and Bank Details** by reading the file's text and pattern-matching common invoice phrasing ("Amount Due", "Invoice Date", "Due Date", "Account No.", "IFSC", etc). This is best-effort, not real OCR/AI — it works well on clean, typed invoices and can miss on messy scans or unusual layouts. It only fills fields you haven't already typed into, and always leaves a note telling you what happened, so you review before saving rather than trusting it blindly. Due Date specifically is only filled when the text clearly labels one — unlike Invoice Date, it won't guess from an unlabeled date elsewhere on the page, since getting that wrong would misstate when payment is actually owed.

Two things to know about this feature:
- It needs two extra packages (`pdf-parse` for PDFs, `tesseract.js` for images) — already added to `package.json`, so `npm install` picks them up.
- **Tesseract.js (used for scanned images) downloads its English trained-data file from a CDN the first time it runs on a machine**, so that first image upload needs internet access. PDFs don't have this requirement (`pdf-parse` reads embedded text directly, no download needed). If a machine will run fully offline, only attach PDFs, or pre-cache the trained-data file per tesseract.js's docs.
- Attached files are stored in an `uploads/` folder next to `server.js` (auto-created, gitignored) and are only reachable through the logged-in API — there's no public static file listing of them.

## Adding things back later

This simple version still runs on SQLite and a single Node process rather than PostgreSQL + a scaled backend. That's the honest gap if you ever need this to support genuinely large concurrent usage (hundreds/thousands of simultaneous users) — that requires a real database server, connection pooling, caching, and proper deployment infrastructure, not just code changes here. For a small team on one machine, what's here now is solid; for real production scale, that's a separate, bigger conversation.
