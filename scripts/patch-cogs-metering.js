// Patch qbo-cogs.js to include Tom AI usage in COGS calculation
const fs = require('fs');
const cogsPath = '/root/joblink-v2/lib/qbo-cogs.js';
let code = fs.readFileSync(cogsPath, 'utf8');

if (code.includes('ai-metering')) {
  console.log('qbo-cogs.js already patched — skipping');
  process.exit(0);
}

// Add metering import
code = code.replace(
  'const qbo = require("./qbo-client");',
  'const qbo = require("./qbo-client");\nconst { getUsageSummary } = require("./ai-metering");'
);

// Replace the placeholder JobLink cost calculation
code = code.replace(
  `  // JobLink costs — currently no AI metering, so estimate from blast/parse counts
  // This will be enhanced when tom_usage tracking is added
  const jlCost = 0; // Placeholder until AI metering is built`,
  `  // JobLink AI costs — from tom_usage table (metered per API call)
  const aiUsage = getUsageSummary(1, month);
  const jlCost = aiUsage.estimatedCost;`
);

// Update the note
code = code.replace(
  '"AI usage metering not yet implemented — $0 until tom_usage tracking is built"',
  'aiUsage.totalCalls > 0 ? `${aiUsage.totalCalls} API calls, ${aiUsage.inputTokens + aiUsage.outputTokens} tokens` : "No API calls this month"'
);

fs.writeFileSync(cogsPath, code);
console.log('Patched qbo-cogs.js to include Tom AI costs from metering');
