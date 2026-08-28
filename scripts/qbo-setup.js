#!/usr/bin/env node
// scripts/qbo-setup.js — Idempotent QBO setup: Chart of Accounts + Customers
// Run once after OAuth connect. Safe to re-run (checks for existing entities).
const qbo = require("../lib/qbo-client");

const ACCOUNTS = [
  // Revenue accounts
  { Name: "JobLink Subscriptions", AccountType: "Income", AccountSubType: "ServiceFeeIncome" },
  { Name: "ResumeLine Subscriptions", AccountType: "Income", AccountSubType: "ServiceFeeIncome" },
  { Name: "FrontLine Subscriptions", AccountType: "Income", AccountSubType: "ServiceFeeIncome" },
  { Name: "Setup Fees", AccountType: "Income", AccountSubType: "ServiceFeeIncome" },
  // COGS accounts
  { Name: "AI Compute (Anthropic)", AccountType: "Cost of Goods Sold", AccountSubType: "CostOfLaborCos" },
  { Name: "Voice (Retell)", AccountType: "Cost of Goods Sold", AccountSubType: "CostOfLaborCos" },
  { Name: "SMS (Whippy)", AccountType: "Cost of Goods Sold", AccountSubType: "CostOfLaborCos" },
  { Name: "Email (Resend)", AccountType: "Cost of Goods Sold", AccountSubType: "CostOfLaborCos" },
  // Expense accounts
  { Name: "Hosting (Hostinger)", AccountType: "Expense", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Name: "Hosting (Cloudflare)", AccountType: "Expense", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Name: "Domains", AccountType: "Expense", AccountSubType: "OtherMiscellaneousServiceCost" },
  { Name: "Insurance (Embroker)", AccountType: "Expense", AccountSubType: "Insurance" },
];

const CUSTOMERS = [
  {
    DisplayName: "Express Employment - Waxahachie",
    PrimaryEmailAddr: { Address: "matt.tibbetts@expresspros.com" },
    Notes: "Matt Tibbetts — org_id=1, 45% owner, COGS billed monthly",
  },
];

async function findAccount(name) {
  const result = await qbo.qboQuery(`SELECT * FROM Account WHERE Name = '${name}'`);
  const accounts = result.QueryResponse?.Account;
  return accounts && accounts.length > 0 ? accounts[0] : null;
}

async function findCustomer(name) {
  const result = await qbo.qboQuery(`SELECT * FROM Customer WHERE DisplayName = '${name}'`);
  const customers = result.QueryResponse?.Customer;
  return customers && customers.length > 0 ? customers[0] : null;
}

async function main() {
  console.log("QBO Setup — checking connection...\n");
  const health = await qbo.healthCheck();
  console.log(`Connected to: ${health.company} (realm ${health.realm_id})`);
  console.log(`Token expires: ${health.token_expires}\n`);

  // Create accounts
  console.log("=== Chart of Accounts ===");
  let created = 0, skipped = 0;
  for (const acct of ACCOUNTS) {
    const existing = await findAccount(acct.Name);
    if (existing) {
      console.log(`  [skip] ${acct.Name} (id=${existing.Id})`);
      skipped++;
    } else {
      const result = await qbo.qboPost("account", acct);
      console.log(`  [created] ${acct.Name} (id=${result.Account.Id})`);
      created++;
    }
  }
  console.log(`\nAccounts: ${created} created, ${skipped} skipped\n`);

  // Create customers
  console.log("=== Customers ===");
  let custCreated = 0, custSkipped = 0;
  for (const cust of CUSTOMERS) {
    const existing = await findCustomer(cust.DisplayName);
    if (existing) {
      console.log(`  [skip] ${cust.DisplayName} (id=${existing.Id})`);
      custSkipped++;
    } else {
      const result = await qbo.qboPost("customer", cust);
      console.log(`  [created] ${cust.DisplayName} (id=${result.Customer.Id})`);
      custCreated++;
    }
  }
  console.log(`\nCustomers: ${custCreated} created, ${custSkipped} skipped\n`);

  console.log("Setup complete.");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
