const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { extractInvoiceDetails } = require('./lib/invoiceExtract');

const app = express();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-before-real-use';

// Invoice attachments live outside of /public (which is served directly) so
// they can only be reached through the authenticated API routes below.
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const INVOICES_DIR = path.join(UPLOADS_DIR, 'invoices');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(INVOICES_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only PDF or image files are supported'), ok);
  },
});

// Safety net: if something still throws outside of a request (or a promise
// rejection slips past asyncHandler below), log it instead of letting Node
// crash the whole server. A crashed server is why every page in the browser
// suddenly shows "connection refused" - this keeps it running no matter what.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server stayed up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed up):', err);
});

// Wraps every async route so a thrown error (e.g. looking up something that
// was just deleted) turns into a proper error response instead of crashing
// the whole Node process. Every route below uses this instead of a bare
// async function.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.use(express.json());
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// ---------- Auth ----------
// Every write endpoint below requires a valid token (requireAuth).
// Destructive endpoints (deleting verticals/projects) additionally require
// an EXEC or FINANCE role (requireRole) - a PROJECT_MANAGER can create and
// add entries, but can't delete.

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header ? header.replace('Bearer ', '') : req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role });
});

// Everything below requires a logged-in user. Login/me above are the only
// public API routes.
app.use('/api', requireAuth);

// ---------- P&L rollup logic ----------
// Nothing above the raw revenue/expense rows is stored anywhere.
// Project P&L, vertical P&L, and company P&L are all calculated fresh,
// every time, from these two tables. Add a revenue entry, and every
// level above it is correct on the very next request - nothing to sync.

async function getProjectPnl(projectId) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const revenue = await prisma.revenueEntry.aggregate({
    where: { projectId },
    _sum: { amount: true },
  });

  const expenseRows = await prisma.expenseEntry.groupBy({
    by: ['category'],
    where: { projectId },
    _sum: { amount: true },
  });

  const categories = await prisma.expenseCategory.findMany();
  const nameByKey = Object.fromEntries(categories.map((c) => [c.key, c.name]));

  const costBreakdown = expenseRows
    .map((row) => ({
      key: row.category,
      name: nameByKey[row.category] || row.category,
      amount: row._sum.amount || 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const totalRevenue = revenue._sum.amount || 0;
  const totalExpenses = costBreakdown.reduce((s, c) => s + c.amount, 0);
  const netProfit = totalRevenue - totalExpenses;
  const profitMarginPct = totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(2)) : 0;

  return {
    projectId: project.id,
    projectName: project.name,
    verticalId: project.verticalId,
    status: project.status,
    totalRevenue,
    costBreakdown,
    totalExpenses,
    netProfit,
    profitMarginPct,
  };
}

function sumPnls(items) {
  const totalRevenue = items.reduce((s, i) => s + i.totalRevenue, 0);
  const totalExpenses = items.reduce((s, i) => s + i.totalExpenses, 0);
  const netProfit = totalRevenue - totalExpenses;
  const profitMarginPct = totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(2)) : 0;
  return { totalRevenue, totalExpenses, netProfit, profitMarginPct };
}

async function getVerticalDashboard(verticalId) {
  const vertical = await prisma.vertical.findUniqueOrThrow({ where: { id: verticalId } });
  const projects = await prisma.project.findMany({ where: { verticalId } });
  const projectPnls = await Promise.all(projects.map((p) => getProjectPnl(p.id)));

  return {
    vertical: { id: vertical.id, name: vertical.name, code: vertical.code },
    activeProjectCount: projects.filter((p) => p.status === 'ACTIVE').length,
    ...sumPnls(projectPnls),
    projects: projectPnls,
  };
}

async function getCompanyDashboard() {
  const verticals = await prisma.vertical.findMany();
  const verticalDashboards = await Promise.all(verticals.map((v) => getVerticalDashboard(v.id)));
  const allProjects = verticalDashboards.flatMap((v) => v.projects);
  const sortedByProfit = [...allProjects].sort((a, b) => b.netProfit - a.netProfit);

  const expenseTotalsByKey = {};
  const nameByKey = {};
  for (const project of allProjects) {
    for (const c of project.costBreakdown) {
      expenseTotalsByKey[c.key] = (expenseTotalsByKey[c.key] || 0) + c.amount;
      nameByKey[c.key] = c.name;
    }
  }
  const expenseBreakdown = Object.entries(expenseTotalsByKey)
    .map(([key, amount]) => ({ key, name: nameByKey[key], amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    ...sumPnls(verticalDashboards),
    verticalCount: verticals.length,
    activeProjectCount: verticalDashboards.reduce((s, v) => s + v.activeProjectCount, 0),
    revenueByVertical: verticalDashboards.map((v) => ({ vertical: v.vertical.name, revenue: v.totalRevenue })),
    profitByVertical: verticalDashboards.map((v) => ({ vertical: v.vertical.name, profit: v.netProfit })),
    expensesByVertical: verticalDashboards.map((v) => ({ vertical: v.vertical.name, expenses: v.totalExpenses })),
    expenseBreakdown,
    verticals: verticalDashboards.map((v) => ({ id: v.vertical.id, name: v.vertical.name })),
    topProfitableProjects: sortedByProfit.slice(0, 5),
    lossMakingProjects: sortedByProfit.filter((p) => p.netProfit < 0).slice(-5).reverse(),
  };
}

async function getCompanyTrend() {
  const now = new Date();
  const buckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleString('en-US', { month: 'short' }), revenue: 0, expenses: 0 });
  }

  const bucketFor = (date) => buckets.find((b) => b.year === date.getFullYear() && b.month === date.getMonth());

  const revenueEntries = await prisma.revenueEntry.findMany({ select: { amount: true, entryDate: true } });
  for (const r of revenueEntries) {
    const b = bucketFor(new Date(r.entryDate));
    if (b) b.revenue += r.amount;
  }

  const expenseEntries = await prisma.expenseEntry.findMany({ select: { amount: true, entryDate: true } });
  for (const e of expenseEntries) {
    const b = bucketFor(new Date(e.entryDate));
    if (b) b.expenses += e.amount;
  }

  return buckets.map((b) => ({ label: b.label, revenue: b.revenue, expenses: b.expenses }));
}

// ---------- Routes ----------

app.get('/api/dashboard/company', asyncHandler(async (req, res) => {
  res.json(await getCompanyDashboard());
}));

app.get('/api/dashboard/company/trend', asyncHandler(async (req, res) => {
  res.json(await getCompanyTrend());
}));

app.get('/api/dashboard/vertical/:verticalId', asyncHandler(async (req, res) => {
  res.json(await getVerticalDashboard(req.params.verticalId));
}));

app.get('/api/projects/:projectId/pnl', asyncHandler(async (req, res) => {
  res.json(await getProjectPnl(req.params.projectId));
}));

app.get('/api/verticals', asyncHandler(async (req, res) => {
  res.json(await prisma.vertical.findMany({ orderBy: { name: 'asc' } }));
}));

app.get('/api/all-projects', asyncHandler(async (req, res) => {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json(projects);
}));

function withComputedVendorStatus(vendor) {
  const now = new Date();
  const isOverdue = !vendor.paid && new Date(vendor.dueDate) < now;
  return {
    ...vendor,
    status: vendor.paid ? 'PAID' : isOverdue ? 'OVERDUE' : 'PENDING',
  };
}

// ---------- Vendor invoice attachments ----------
// Flow: the form uploads the file here first (before the vendor is saved),
// we run best-effort text extraction on it for auto-fill, and stash the
// file under uploads/tmp/<token>. The token then travels with the rest of
// the vendor form as a plain string field. Only once the vendor is actually
// created/updated do we move the file from tmp/ into its permanent home -
// so nothing is left attached to a vendor the user never actually saved.
app.post('/api/invoice-extract', upload.single('invoice'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const token = `${crypto.randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
  fs.writeFileSync(path.join(TMP_DIR, token), req.file.buffer);

  let guessed = { vendorName: null, service: null, amount: null, invoiceDate: null, dueDate: null, bankDetails: null };
  let extractionError = null;
  try {
    const result = await extractInvoiceDetails(req.file.buffer, req.file.mimetype);
    guessed = result.guessed;
  } catch (err) {
    // Extraction failing (e.g. tesseract couldn't reach its trained-data CDN
    // on first run) shouldn't block the upload - the file is already saved,
    // the user just fills the form in manually instead.
    extractionError = err.message;
  }

  res.json({ fileToken: token, fileName: req.file.originalname, guessed, extractionError });
}));

function finalizeInvoiceToken(token) {
  const safeToken = path.basename(token); // guard against path traversal
  const tmpPath = path.join(TMP_DIR, safeToken);
  if (!fs.existsSync(tmpPath)) throw Object.assign(new Error('Uploaded file expired - please re-attach it'), { status: 400 });
  const finalName = `${crypto.randomUUID()}-${safeToken.split('-').slice(1).join('-')}`;
  fs.renameSync(tmpPath, path.join(INVOICES_DIR, finalName));
  return finalName;
}

app.get('/api/vendors/:id/invoice-file', asyncHandler(async (req, res) => {
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!vendor.invoiceFile) return res.status(404).json({ error: 'No invoice attached' });
  const filePath = path.join(INVOICES_DIR, vendor.invoiceFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File is missing on disk' });
  res.sendFile(filePath);
}));

app.delete('/api/vendors/:id/invoice-file', asyncHandler(async (req, res) => {
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: req.params.id } });
  if (vendor.invoiceFile) {
    const filePath = path.join(INVOICES_DIR, vendor.invoiceFile);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const updated = await prisma.vendor.update({ where: { id: req.params.id }, data: { invoiceFile: null } });
  res.json(withComputedVendorStatus(updated));
}));


app.get('/api/vendors', asyncHandler(async (req, res) => {
  const vendors = await prisma.vendor.findMany({
    orderBy: { dueDate: 'asc' },
    include: { project: { select: { id: true, name: true } } },
  });
  const withStatus = vendors.map(withComputedVendorStatus);

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const summary = {
    overdueCount: withStatus.filter((v) => v.status === 'OVERDUE').length,
    dueSoonCount: withStatus.filter((v) => v.status === 'PENDING' && new Date(v.dueDate) <= in7Days).length,
    totalOwed: withStatus.filter((v) => !v.paid).reduce((s, v) => s + v.paymentAmount, 0),
  };

  res.json({ vendors: withStatus, summary });
}));

app.post('/api/vendors', asyncHandler(async (req, res) => {
  const {
    name, paymentAmount, dueDate, projectId,
    invoiceDate, quarter, poc, approvedBy, lastPaymentDate, paymentTimeline,
    invoiceFileToken, service, bankDetails,
  } = req.body;
  if (!name || !paymentAmount || !dueDate) {
    return res.status(400).json({ error: 'Name/Service, amount, and deadline are required' });
  }
  const vendor = await prisma.vendor.create({
    data: {
      name,
      service: service || null,
      paymentAmount: Number(paymentAmount),
      dueDate: new Date(dueDate),
      projectId: projectId || null,
      invoiceDate: invoiceDate ? new Date(invoiceDate) : null,
      quarter: quarter || null,
      poc: poc || null,
      approvedBy: approvedBy || null,
      lastPaymentDate: lastPaymentDate ? new Date(lastPaymentDate) : null,
      paymentTimeline: paymentTimeline || null,
      bankDetails: bankDetails || null,
      invoiceFile: invoiceFileToken ? finalizeInvoiceToken(invoiceFileToken) : null,
    },
  });
  res.json(withComputedVendorStatus(vendor));
}));

app.patch('/api/vendors/:id', asyncHandler(async (req, res) => {
  const {
    name, paymentAmount, dueDate, paid, projectId,
    invoiceDate, quarter, poc, approvedBy, lastPaymentDate, paymentTimeline,
    invoiceFileToken, service, bankDetails,
  } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (service !== undefined) data.service = service || null;
  if (paymentAmount !== undefined) data.paymentAmount = Number(paymentAmount);
  if (dueDate !== undefined) data.dueDate = new Date(dueDate);
  if (paid !== undefined) data.paid = paid;
  if (projectId !== undefined) data.projectId = projectId || null;
  if (invoiceDate !== undefined) data.invoiceDate = invoiceDate ? new Date(invoiceDate) : null;
  if (quarter !== undefined) data.quarter = quarter || null;
  if (poc !== undefined) data.poc = poc || null;
  if (approvedBy !== undefined) data.approvedBy = approvedBy || null;
  if (lastPaymentDate !== undefined) data.lastPaymentDate = lastPaymentDate ? new Date(lastPaymentDate) : null;
  if (paymentTimeline !== undefined) data.paymentTimeline = paymentTimeline || null;
  if (bankDetails !== undefined) data.bankDetails = bankDetails || null;

  if (invoiceFileToken) {
    // Replacing an attachment - drop the old file first so we don't leak it.
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { invoiceFile: true } });
    if (existing?.invoiceFile) {
      const oldPath = path.join(INVOICES_DIR, existing.invoiceFile);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    data.invoiceFile = finalizeInvoiceToken(invoiceFileToken);
  }

  const vendor = await prisma.vendor.update({ where: { id: req.params.id }, data });
  res.json(withComputedVendorStatus(vendor));
}));

app.delete('/api/vendors/:id', asyncHandler(async (req, res) => {
  await prisma.vendor.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ---------- Users ----------
// User management is EXEC-only - this is the one place that can grant or
// revoke access to the whole system, so it's more locked down than the
// delete-only EXEC/FINANCE split used elsewhere.
app.get('/api/users', requireRole('EXEC'), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  res.json(users);
}));

app.post('/api/users', requireRole('EXEC'), asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const allowedRoles = ['EXEC', 'FINANCE', 'VERTICAL_HEAD', 'PROJECT_MANAGER'];
  if (role && !allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({
      data: { name, email, passwordHash, role: role || 'PROJECT_MANAGER' },
    });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That email is already in use' });
    throw err;
  }
}));

app.patch('/api/users/:id', requireRole('EXEC'), asyncHandler(async (req, res) => {
  const { name, role, password } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (role !== undefined) data.role = role;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    data.passwordHash = await bcrypt.hash(password, 10);
  }
  const user = await prisma.user.update({ where: { id: req.params.id }, data });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
}));

app.delete('/api/users/:id', requireRole('EXEC'), asyncHandler(async (req, res) => {
  if (req.params.id === req.user.sub) {
    return res.status(400).json({ error: "You can't delete your own account while logged in as it" });
  }
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));


// ---------- Vendor dropdown option lists (POC / Approved by / Quarter / Payment Timeline) ----------
// Same pattern as ExpenseCategory below: vendor rows store the option's text
// value directly, not an id, so renaming an option updates every vendor that
// uses it, and deleting one never breaks a vendor row that already has it.
const VENDOR_OPTION_TYPES = ['POC', 'APPROVER', 'QUARTER', 'PAYMENT_TIMELINE'];
const VENDOR_OPTION_FIELD = { POC: 'poc', APPROVER: 'approvedBy', QUARTER: 'quarter', PAYMENT_TIMELINE: 'paymentTimeline' };

app.get('/api/vendor-options', asyncHandler(async (req, res) => {
  const where = req.query.type ? { type: req.query.type } : {};
  const options = await prisma.vendorOption.findMany({ where, orderBy: { value: 'asc' } });
  res.json(options);
}));

app.post('/api/vendor-options', asyncHandler(async (req, res) => {
  const { type, value } = req.body;
  if (!VENDOR_OPTION_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid option type' });
  const trimmed = (value || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Value is required' });
  try {
    const option = await prisma.vendorOption.create({ data: { type, value: trimmed } });
    res.json(option);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: `"${trimmed}" already exists in this list` });
    throw err;
  }
}));

app.patch('/api/vendor-options/:id', asyncHandler(async (req, res) => {
  const trimmed = (req.body.value || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Value is required' });
  const existing = await prisma.vendorOption.findUniqueOrThrow({ where: { id: req.params.id } });

  // Renaming an option also updates every vendor currently using the old
  // value, so the change is reflected everywhere instead of just going
  // forward from here.
  const field = VENDOR_OPTION_FIELD[existing.type];
  await prisma.vendor.updateMany({
    where: { [field]: existing.value },
    data: { [field]: trimmed },
  });

  const option = await prisma.vendorOption.update({ where: { id: req.params.id }, data: { value: trimmed } });
  res.json(option);
}));

app.delete('/api/vendor-options/:id', asyncHandler(async (req, res) => {
  await prisma.vendorOption.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ---------- Workspace reset ----------
// Wipes every seeded/demo record so a team can start from a genuinely empty
// workspace and build their own verticals/projects/vendors. Logins are
// deliberately untouched so nobody gets locked out of their own reset.
app.post('/api/workspace/reset', requireRole('EXEC'), asyncHandler(async (req, res) => {
  await prisma.expenseEntry.deleteMany({});
  await prisma.revenueEntry.deleteMany({});
  await prisma.vendor.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.vertical.deleteMany({});
  await prisma.vendorOption.deleteMany({});
  res.json({ success: true });
}));


app.get('/api/expense-categories', asyncHandler(async (req, res) => {
  res.json(await prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } }));
}));

app.post('/api/expense-categories', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required' });

  let key = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) return res.status(400).json({ error: 'That name could not be turned into a valid category' });

  // Ensure the generated key is unique even if two different names collide
  const existing = await prisma.expenseCategory.findUnique({ where: { key } });
  if (existing) return res.status(400).json({ error: `A category with a matching key ("${existing.name}") already exists` });

  const category = await prisma.expenseCategory.create({ data: { key, name } });
  res.json(category);
}));

app.patch('/api/expense-categories/:id', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const category = await prisma.expenseCategory.update({
    where: { id: req.params.id },
    data: { name }, // key stays the same so existing expense entries keep pointing at this category
  });
  res.json(category);
}));

app.delete('/api/expense-categories/:id', asyncHandler(async (req, res) => {
  const category = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: req.params.id } });
  const inUse = await prisma.expenseEntry.count({ where: { category: category.key } });
  if (inUse > 0) {
    return res.status(400).json({ error: `Can't delete "${category.name}" - ${inUse} expense entr${inUse === 1 ? 'y uses' : 'ies use'} it. Reassign or delete those first.` });
  }
  await prisma.expenseCategory.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

app.post('/api/verticals', asyncHandler(async (req, res) => {
  const vertical = await prisma.vertical.create({
    data: { name: req.body.name, code: req.body.code },
  });
  res.json(vertical);
}));

app.patch('/api/verticals/:id', asyncHandler(async (req, res) => {
  const vertical = await prisma.vertical.update({
    where: { id: req.params.id },
    data: { name: req.body.name },
  });
  res.json(vertical);
}));

app.delete('/api/verticals/:id', requireRole('EXEC', 'FINANCE'), asyncHandler(async (req, res) => {
  const verticalId = req.params.id;
  const projects = await prisma.project.findMany({ where: { verticalId }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);

  // Clean up child records manually so the delete never hits a foreign-key error
  await prisma.expenseEntry.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.revenueEntry.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { verticalId } });
  await prisma.vertical.delete({ where: { id: verticalId } });

  res.json({ success: true });
}));

app.post('/api/projects', asyncHandler(async (req, res) => {
  const project = await prisma.project.create({
    data: { name: req.body.name, verticalId: req.body.verticalId },
  });
  res.json(project);
}));

app.patch('/api/projects/:id', asyncHandler(async (req, res) => {
  const data = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  const project = await prisma.project.update({
    where: { id: req.params.id },
    data,
  });
  res.json(project);
}));

app.delete('/api/projects/:id', requireRole('EXEC', 'FINANCE'), asyncHandler(async (req, res) => {
  const projectId = req.params.id;
  await prisma.expenseEntry.deleteMany({ where: { projectId } });
  await prisma.revenueEntry.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  res.json({ success: true });
}));

app.get('/api/projects/:projectId/revenue', asyncHandler(async (req, res) => {
  const entries = await prisma.revenueEntry.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { entryDate: 'desc' },
  });
  res.json(entries);
}));

app.post('/api/projects/:projectId/revenue', asyncHandler(async (req, res) => {
  const entry = await prisma.revenueEntry.create({
    data: { projectId: req.params.projectId, amount: req.body.amount, source: req.body.source },
  });
  res.json(entry);
}));

app.patch('/api/revenue/:id', asyncHandler(async (req, res) => {
  const entry = await prisma.revenueEntry.update({
    where: { id: req.params.id },
    data: { amount: req.body.amount, source: req.body.source },
  });
  res.json(entry);
}));

app.delete('/api/revenue/:id', asyncHandler(async (req, res) => {
  await prisma.revenueEntry.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

app.get('/api/projects/:projectId/expenses', asyncHandler(async (req, res) => {
  const entries = await prisma.expenseEntry.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { entryDate: 'desc' },
  });
  res.json(entries);
}));

app.post('/api/projects/:projectId/expenses', asyncHandler(async (req, res) => {
  const entry = await prisma.expenseEntry.create({
    data: {
      projectId: req.params.projectId,
      amount: req.body.amount,
      category: req.body.category,
      note: req.body.note,
    },
  });
  res.json(entry);
}));

app.patch('/api/expenses/:id', asyncHandler(async (req, res) => {
  const entry = await prisma.expenseEntry.update({
    where: { id: req.params.id },
    data: { amount: req.body.amount, category: req.body.category, note: req.body.note },
  });
  res.json(entry);
}));

app.delete('/api/expenses/:id', asyncHandler(async (req, res) => {
  await prisma.expenseEntry.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));



// Catches every error passed via next(err) from asyncHandler above, so the
// browser gets a proper error response instead of the server dying.
app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'That item no longer exists - it may have just been deleted or renamed elsewhere.' });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`P&L dashboard running at http://localhost:${PORT}`));
