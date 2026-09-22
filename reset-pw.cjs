const bcrypt = require("/root/joblink-v2/node_modules/bcryptjs");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("/root/joblink-v2/data/system.db");
const hash = bcrypt.hashSync("joblink2026", 10);

// Update Matt's login (id=6, matt@joblinkplatform.com) to matt.tibbetts@expresspros.com
db.exec(`UPDATE users SET email = 'matt.tibbetts@expresspros.com' WHERE id = 6`);
console.log("Updated Matt's email: matt@joblinkplatform.com → matt.tibbetts@expresspros.com");

// Reset ALL org_id=1 passwords to joblink2026
const org1Users = db.prepare("SELECT id, email, display_name FROM users WHERE org_id = 1").all();
for (const u of org1Users) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  console.log("  Reset:", u.email, "-", u.display_name);
}

console.log("\nDone. All org 1 users (" + org1Users.length + ") set to password: joblink2026");
db.close();
