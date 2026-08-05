const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

async function main() {
  // Seed users with different roles. Everyone uses the password "password123"
  // for this local demo - change this before using it for anything real.
  const seedUsers = [
    { name: 'Admin Exec', email: 'admin@company.com', role: 'EXEC' },
    { name: 'Finance Lead', email: 'finance@company.com', role: 'FINANCE' },
    { name: 'Project Manager', email: 'pm@company.com', role: 'PROJECT_MANAGER' },
  ];
  const passwordHash = await bcrypt.hash('password123', 10);
  for (const u of seedUsers) {
    await prisma.user.create({ data: { ...u, passwordHash } });
  }

  const verticals = [
    ['a-tom content studio', 'studio'],
    ['a-tom social', 'social'],
    ['Chopshop lab', 'cs'],
    ['Misfits', 'misfits'],
    ['Ngen', 'ngen'],
    ['IRL', 'irl'],
  ];

  const categories = ['EMPLOYEE', 'FREELANCER', 'VENDOR', 'SOFTWARE', 'MISC'];
  const categoryNames = { EMPLOYEE: 'Employee', FREELANCER: 'Freelancer', VENDOR: 'Vendor', SOFTWARE: 'Software', MISC: 'Misc' };
  for (const key of categories) {
    await prisma.expenseCategory.create({ data: { key, name: categoryNames[key] } });
  }

  // These 2 existing projects are deliberately set up to run at a loss
  // (lower revenue, same normal expenses) so the "Loss-making" list on the
  // dashboard has real entries to show instead of being empty.
  const lossMakers = new Set(['MKT-1', 'OPS-2']);

  for (const [name, code] of verticals) {
    const vertical = await prisma.vertical.create({ data: { name, code } });

    for (let i = 1; i <= 2; i++) {
      const project = await prisma.project.create({
        data: { name: `${name} Project ${i}`, verticalId: vertical.id },
      });

      const isLossMaker = lossMakers.has(`${code}-${i}`);

      // Spread revenue and expenses across the last 6 months so trend charts
      // have real month-over-month movement instead of one lump entry.
      for (let m = 5; m >= 0; m--) {
        const entryDate = monthsAgo(m);
        const monthFactor = 0.7 + Math.random() * 0.6; // natural variance month to month

        const revenueBase = isLossMaker ? 3000 + i * 300 : 8000 + i * 1500;
        await prisma.revenueEntry.create({
          data: {
            projectId: project.id,
            amount: Math.round(revenueBase * monthFactor),
            source: 'Client invoice',
            entryDate,
          },
        });

        for (const category of categories) {
          await prisma.expenseEntry.create({
            data: {
              projectId: project.id,
              amount: Math.round((600 + Math.random() * 900) * monthFactor),
              category,
              entryDate,
            },
          });
        }
      }
    }
  }

  const firstProject = await prisma.project.findFirst();

  // Dropdown option lists for the Vendors page - editable later from that
  // page's Settings panel.
  const pocs = ['Rahul Menon', 'Sneha Iyer', 'Arjun Nair'];
  const approvers = ['Priya Sharma', 'Vikram Rao'];
  const quarters = ['Q4 FY25', 'Q1 FY26', 'Q2 FY26'];
  const paymentTimelines = ['Immediate', 'Net 15', 'Net 30', 'Net 45'];
  for (const value of pocs) await prisma.vendorOption.create({ data: { type: 'POC', value } });
  for (const value of approvers) await prisma.vendorOption.create({ data: { type: 'APPROVER', value } });
  for (const value of quarters) await prisma.vendorOption.create({ data: { type: 'QUARTER', value } });
  for (const value of paymentTimelines) await prisma.vendorOption.create({ data: { type: 'PAYMENT_TIMELINE', value } });

  await prisma.vendor.createMany({
    data: [
      {
        name: 'Acme Office Supplies', service: 'Office supplies & stationery', paymentAmount: 42000, dueDate: monthsAgo(0.3), paid: false, projectId: firstProject?.id, // overdue
        invoiceDate: monthsAgo(1), quarter: 'Q1 FY26', poc: 'Rahul Menon', approvedBy: 'Priya Sharma',
        paymentTimeline: 'Net 30', bankDetails: 'HDFC Bank\nA/C No: 50100234567890\nIFSC: HDFC0001234',
      },
      {
        name: 'CloudHost Services', service: 'Cloud infrastructure hosting', paymentAmount: 18500, dueDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), paid: false, // due soon
        invoiceDate: monthsAgo(0.2), quarter: 'Q1 FY26', poc: 'Sneha Iyer', approvedBy: 'Priya Sharma',
        paymentTimeline: 'Net 15',
      },
      {
        name: 'Design Studio Partners', service: 'Brand & UI design retainer', paymentAmount: 65000, dueDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000), paid: false, // due later
        invoiceDate: new Date(), quarter: 'Q1 FY26', poc: 'Arjun Nair', approvedBy: 'Vikram Rao',
        paymentTimeline: 'Net 45',
      },
      {
        name: 'Legal Advisory Co.', service: 'Contract review & advisory', paymentAmount: 30000, dueDate: monthsAgo(1), paid: true, // already paid
        invoiceDate: monthsAgo(1.5), quarter: 'Q4 FY25', poc: 'Rahul Menon', approvedBy: 'Vikram Rao',
        lastPaymentDate: monthsAgo(0.9), paymentTimeline: 'Immediate',
      },
    ],
  });

  console.log('Seed complete: 3 users, 6 verticals, 12 projects, 6 months of revenue and expense history.');
  console.log('2 projects (Marketing Project 1, Operations Project 2) are set up as loss-making examples.');
  console.log('Login with: admin@company.com / password123 (EXEC - full access)');
  console.log('        or: finance@company.com / password123 (FINANCE - full access)');
  console.log('        or: pm@company.com / password123 (PROJECT_MANAGER - cannot delete)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
