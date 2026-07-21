const fs = require("fs");
let c = fs.readFileSync("/root/joblink-v2/public/tom.html", "utf8");

// Replace the broken md function with a working one
const broken = c.indexOf("function md(s)");
const brokenEnd = c.indexOf("}", broken) + 1;
const oldFunc = c.substring(broken, brokenEnd);

const newFunc = `function md(s) {
  if (!s) return "";
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>")
    .replace(/^- (.+)/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n/g, "<br>");
}`;

c = c.substring(0, broken) + newFunc + c.substring(brokenEnd);
fs.writeFileSync("/root/joblink-v2/public/tom.html", c);
console.log("Fixed md function");
